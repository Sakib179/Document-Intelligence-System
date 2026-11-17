import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { pageQuerySchema,workspaceUserSchema,dashboardSchema,workspaceDocumentsSchema,sourcePagesSchema,sourcePageSchema,reconciliationHistorySchema } from '@doc/contracts';
import { WorkspaceService, workspaceListQuery } from './service.js';
const ids = z.object({ id: z.uuid() }).strict(), empty = z.object({}).strict();
function context(request: FastifyRequest) {
  if (!request.principal)
    throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.'); return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason: 'Read resolveWorkspaced document workspace' };
}
export function registerWorkspaceRoutes(app: FastifyInstance, pool: pg.Pool, storage: S3Client, env: RuntimeEnvironment, resolveWorkspace: (request: FastifyRequest) => Promise<void>) {
  const service = new WorkspaceService(pool);
  app.get('/v1/me', { onRequest: resolveWorkspace }, async (request) => { empty.parse(request.query); return workspaceUserSchema.parse({ ...await service.me(context(request)), upload_limits: { max_files: env.UPLOAD_MAX_FILES, max_file_bytes: env.UPLOAD_MAX_FILE_BYTES, max_batch_bytes: env.UPLOAD_MAX_BATCH_BYTES } }); });
  app.get('/v1/dashboard', { onRequest: resolveWorkspace }, async request => { empty.parse(request.query);return dashboardSchema.parse(await service.dashboard(context(request))); });
  app.get('/v1/workspace/documents', { onRequest: resolveWorkspace },async request => workspaceDocumentsSchema.parse(await service.documents(context(request), workspaceListQuery.parse(request.query))));
  app.get('/v1/workspace/reconciliations', { onRequest: resolveWorkspace },async request => { const query = pageQuerySchema.parse(request.query); return reconciliationHistorySchema.parse(await service.reconciliations(context(request), query.limit, query.cursor)); });
  app.get('/v1/documents/:id/pages', { onRequest: resolveWorkspace },async request => { const query = pageQuerySchema.parse(request.query); return sourcePagesSchema.parse(await service.pages(context(request), ids.parse(request.params).id, query.limit, query.cursor)); });
  app.get('/v1/documents/:id/pages/:number', { onRequest: resolveWorkspace },async request => { const params = z.object({ id: z.uuid(), number: z.coerce.number().int().positive() }).strict().parse(request.params), query = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).strict().parse(request.query); return sourcePageSchema.parse(await service.page(context(request), params.id, params.number, query.after)); });
  app.get('/v1/documents/:id/content', { onRequest: resolveWorkspace }, async (request, reply) => {
    const query = z.object({ download: z.enum(['1']).optional() }).strict().parse(request.query), doc = await service.document(context(request), ids.parse(request.params).id);
    const range = request.headers.range;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
      throw new ServiceError('INVALID_RANGE', 416, 'Only single byte ranges are supported.');
    try {
      const result = await storage.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: doc.object_storage_key, ...(range ? { Range: range } : {}) }), { abortSignal: AbortSignal.timeout(env.S3_OPERATION_TIMEOUT_MS) });
      if (!result.Body)
        throw new ServiceError('ORIGINAL_UNAVAILABLE', 404, 'Original file is not available.');
      const inline = !query.download && ['application/pdf', 'image/jpeg', 'image/png'].includes(doc.mime_type);
      reply.header('Content-Type', inline ? doc.mime_type : 'application/octet-stream').header('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(doc.original_filename)).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'SAMEORIGIN').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; sandbox").header('Accept-Ranges', 'bytes');
      if (result.ContentLength !== undefined)
        reply.header('Content-Length', result.ContentLength);
      if (result.ContentRange)
        reply.code(206).header('Content-Range', result.ContentRange);
      const body = result.Body as Readable;
      request.raw.once('aborted', () => body.destroy());
      reply.raw.once('close', () => body.destroy());
      return reply.send(body);
    }
    catch (error) {
      if (error instanceof ServiceError)
        throw error;
      const status = (error as {
        $metadata?: {
          httpStatusCode?: number;
        };
      }).$metadata?.httpStatusCode;
      if (status === 404)
        throw new ServiceError('ORIGINAL_UNAVAILABLE', 404, 'Original file is not available for this record.');
      if (status === 416)
        throw new ServiceError('INVALID_RANGE', 416, 'The requested byte range is invalid.');
      throw new ServiceError('STORAGE_UNAVAILABLE', 503, 'Original file storage is unavailable.');
    }
  });
  app.get('/v1/documents/:id/preview', { onRequest: resolveWorkspace }, async (request, reply) => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().parse(request.query), doc = await service.document(context(request), ids.parse(request.params).id);
    if(doc.page_count!==null&&query.page>doc.page_count)throw new ServiceError('PAGE_NOT_FOUND',404,'Source page not found.');
    const extension = doc.object_storage_key.slice(doc.object_storage_key.lastIndexOf('.'));
    if (!['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff'].includes(extension))
      throw new ServiceError('PREVIEW_FORMAT_UNSUPPORTED', 415, 'Use the source worksheet view for this file.');
    let response: Response;
    try {
      response = await fetch('http://' + env.PROCESSOR_HOST + ':' + env.PROCESSOR_PORT + '/internal/preview', { method: 'POST', headers: { authorization: 'Bearer ' + env.PROCESSOR_INTERNAL_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ tenant_id: doc.tenant_id, document_id: doc.id, run_id: randomUUID(), page_number: query.page, source: { bucket: env.S3_BUCKET, key: doc.object_storage_key, sha256: doc.sha256, size_bytes: Number(doc.file_size_bytes), extension } }), signal: AbortSignal.timeout(45000) });
    }
    catch {
      throw new ServiceError('PREVIEW_UNAVAILABLE', 503, 'Document preview is unavailable.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError('PREVIEW_UNAVAILABLE', response.status === 404 ? 404 : 503, 'The original page could not be previewed.');
    }
    if (!response.body)
      throw new ServiceError('PREVIEW_UNAVAILABLE', 503, 'Empty preview response.');
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return reply.send(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream));
  });
  app.delete('/v1/documents/:id', { onRequest: resolveWorkspace }, async (request) => {
    empty.parse(request.query);
    if (!request.principal)
      throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.');
    if (request.principal.role === 'reader')
      throw new ServiceError('FORBIDDEN', 403, 'Reviewer or administrator permission is required to delete documents.');
    const id = ids.parse(request.params).id;
    const deleted = await service.deleteDocument({
      tenantId: request.principal.tenantId,
      actorUserId: request.principal.userId,
      reason: 'Deleted document from workspace',
    }, id);
    // Best-effort removal of private stored original and processing artifacts under the document prefix.
    const prefix = `tenants/${deleted.tenant_id}/documents/${deleted.id}/`;
    try {
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const listed = await storage.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(env.S3_OPERATION_TIMEOUT_MS) });
        const keys = (listed.Contents ?? []).map(item => item.Key).filter((key): key is string => Boolean(key));
        if (keys.length) {
          await storage.send(new DeleteObjectsCommand({ Bucket: env.S3_BUCKET, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }), { abortSignal: AbortSignal.timeout(env.S3_OPERATION_TIMEOUT_MS) });
        }
        if (!listed.IsTruncated || !listed.NextContinuationToken) break;
        token = listed.NextContinuationToken;
      }
    } catch {
      // Database deletion and audit event are already committed; missing/unreachable storage objects stay non-fatal.
    }
    return { deleted: true, id: deleted.id };
  });
}
