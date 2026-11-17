import multipart from '@fastify/multipart';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { documentListSchema, documentStatusSchema, inspectionSchema, processingStatusSchema, documentDtoSchema } from '@doc/contracts';
import { createAntivirusScanner, ServiceError } from '@doc/core';
import type { AntivirusScanner, RuntimeEnvironment,EmbeddingClient } from '@doc/core';
import { registerWorkspaceContext } from '../workspace-context.js';
import { inspectStagedFile, stageMultipart, uploadFingerprint } from './files.js';
import type { StagedFile, ValidatedFile } from './files.js';
import { documentDto, IngestionRepository } from './repository.js';
import { readUnderstanding, understandingQuerySchema } from './understanding.js';
import { registerExtractionRoutes } from './extraction.js';
import { registerFinancialRoutes } from '../financial/routes.js';
import { registerSearchRoutes } from '../search/routes.js';
import { registerWorkflowRoutes } from '../workflow/routes.js';
import { registerWorkspaceRoutes } from '../workspace/routes.js';

const idParams = z.object({ id: z.uuid() }).strict();
const emptyQuery = z.object({}).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), status: documentStatusSchema.optional(), batchId: z.uuid().optional(), cursor: z.string().max(512).optional() }).strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
const detailSchema = z.object({ document: documentDtoSchema, inspection: inspectionSchema.nullable() }).strict();
const batchSchema = z.object({ batchId: z.uuid(), status: z.string(), documents: z.array(documentDtoSchema) }).strict();

function context(request: FastifyRequest) {
  if (!request.principal) throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.');
  return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason: 'Accept document ingestion' };
}

export async function registerIngestionRoutes(app: FastifyInstance, dependencies: {
  environment: RuntimeEnvironment; pool: pg.Pool; storage: S3Client;
  embeddingClient?:EmbeddingClient;
  scanner?: AntivirusScanner; inspect?: (file: StagedFile, environment: RuntimeEnvironment) => Promise<z.infer<typeof inspectionSchema>>;
}) {
  const { environment, pool, storage } = dependencies;
  const repository = new IngestionRepository(pool, environment);
  const scanner = dependencies.scanner ?? createAntivirusScanner(environment);
  const inspect = dependencies.inspect ?? inspectStagedFile;
  const resolveWorkspace = await registerWorkspaceContext(app, pool, environment);
  registerExtractionRoutes(app, pool, environment, resolveWorkspace);
  registerFinancialRoutes(app,pool,resolveWorkspace);
  registerSearchRoutes(app,pool,environment,resolveWorkspace,dependencies.embeddingClient);
  registerWorkflowRoutes(app,pool,environment,resolveWorkspace);
  registerWorkspaceRoutes(app,pool,storage,environment,resolveWorkspace);
  await app.register(multipart, { limits: {
    files: environment.UPLOAD_MAX_FILES, fileSize: environment.UPLOAD_MAX_FILE_BYTES,
    fields: 0, parts: environment.UPLOAD_MAX_FILES, fieldNameSize: 32, headerPairs: 20,
  }, preservePath: true });
  let activeUploads = 0;

  app.post('/v1/upload-batches', {
    onRequest: resolveWorkspace,
  }, async (request, reply) => {
    const tenant = context(request);
    if (request.principal?.role === 'reader') throw new ServiceError('FORBIDDEN', 403, 'This user cannot upload documents.');
    emptyQuery.parse(request.query);
    const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).parse(request.headers['idempotency-key'] ?? randomUUID());
    if (activeUploads >= environment.UPLOAD_MAX_CONCURRENT) throw new ServiceError('UPLOAD_CAPACITY_REACHED', 429, 'Upload capacity is temporarily full.');
    activeUploads++;
    let staged: Awaited<ReturnType<typeof stageMultipart>> | undefined;
    try {
      staged = await stageMultipart(request, environment);
      const fingerprint = uploadFingerprint(staged.files);
      const replay = await repository.findReplay(tenant, key, fingerprint);
      if (replay) return reply.code(202).header('Location', '/v1/upload-batches/' + replay.batchId).send(replay);
      const validated: ValidatedFile[] = [];
      for (const file of staged.files) {
        validated.push({ ...file, antivirus: await scanner.scan(file.path), inspection: await inspect(file, environment) });
      }
      const reservation = await repository.reserve(tenant, key, fingerprint, validated);
      if (reservation.replay) return reply.code(202).send(reservation.replay);
      let stage = 'object_storage';
      try {
        for (const [index, document] of reservation.documents.entries()) {
          const file = validated[index];
          if (!file) throw new Error('Missing staged file');
          const source = createReadStream(file.path);
          try {
            await storage.send(new PutObjectCommand({
              Bucket: environment.S3_BUCKET, Key: document.object_storage_key, Body: source,
              ContentLength: file.sizeBytes, ContentType: file.mimeType,
              ContentDisposition: "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
              ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64'),
              Metadata: { 'tenant-id': tenant.tenantId, 'document-id': document.id, sha256: file.sha256 },
            }), { abortSignal: AbortSignal.timeout(environment.S3_OPERATION_TIMEOUT_MS) });
          } finally { source.destroy(); }
        }
        stage = 'metadata_commit';
        const accepted = await repository.finalize(tenant, reservation, key);
        return reply.code(202).header('Location', '/v1/upload-batches/' + accepted.batchId).send(accepted);
      } catch (error) {
        const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
        app.log.error({ errorCode, stage }, 'Upload persistence failed');
        try { await repository.markStorageFailure(tenant, reservation); } catch { app.log.error('Failed to persist upload failure; its durable reservation remains recoverable'); }
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('STORAGE_WRITE_FAILED', 503, 'Storage or metadata persistence failed. Retry using the same idempotency key.');
      }
    } finally {
      activeUploads--;
      try { await staged?.cleanup(); } catch { app.log.warn('Private upload staging cleanup failed'); }
    }
  });

  app.get('/v1/documents', { onRequest: resolveWorkspace }, async (request) => {
    const query = listQuery.parse(request.query);
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); }
      catch { throw new ServiceError('INVALID_CURSOR', 400, 'The pagination cursor is invalid.'); }
    }
    const rows = await repository.list(context(request), { ...query, cursor });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify({ createdAt: last.precise_created_at, id: last.id })).toString('base64url') : null;
    return documentListSchema.parse({ documents: page.map(documentDto), nextCursor });
  });

  app.get('/v1/documents/:id', { onRequest: resolveWorkspace }, async (request) => {
    emptyQuery.parse(request.query);
    const { id } = idParams.parse(request.params);
    const document = await repository.getDocument(context(request), id);
    return detailSchema.parse({ document: documentDto(document), inspection: document.metadata.ingestion?.inspection ?? null });
  });

  app.get('/v1/documents/:id/status', { onRequest: resolveWorkspace }, async (request) => {
    emptyQuery.parse(request.query);
    const { id } = idParams.parse(request.params);
    const tenant = context(request);
    const document = await repository.getDocument(tenant, id);
    return processingStatusSchema.parse({ documentId: id, status: document.processing_status, jobs: await repository.jobStatuses(tenant, id) });
  });

  app.get('/v1/documents/:id/understanding', { onRequest: resolveWorkspace }, async (request) => {
    const { id } = idParams.parse(request.params);
    return readUnderstanding(pool, context(request), id, understandingQuerySchema.parse(request.query));
  });

  app.get('/v1/upload-batches/:id', { onRequest: resolveWorkspace }, async (request) => {
    emptyQuery.parse(request.query);
    const { id } = idParams.parse(request.params);
    return batchSchema.parse(await repository.batch(context(request), id));
  });
}
