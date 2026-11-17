import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { searchQuerySchema, indexingAcceptedSchema } from '@doc/contracts';
import { IndexRepository, searchDocuments } from '@doc/database';
import { LocalEmbeddingClient, ServiceError, embeddingSpace } from '@doc/core';
import type { RuntimeEnvironment, EmbeddingClient } from '@doc/core';
const params = z.object({ id: z.uuid() }).strict(), empty = z.object({}).strict(), start = z.object({ reindex: z.boolean().default(false) }).strict();
function principal(request: FastifyRequest, writing = false) {
  if (!request.principal)
    throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.'); if (writing && request.principal.role === 'reader')
    throw new ServiceError('FORBIDDEN', 403, 'Readers cannot create indexes.'); return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason: writing ? 'Request local search indexing' : 'Search tenant documents' };
}
export function registerSearchRoutes(app: FastifyInstance, pool: pg.Pool, env: RuntimeEnvironment, resolveWorkspace: (request: FastifyRequest) => Promise<void>, client: EmbeddingClient = new LocalEmbeddingClient(env)) {
  const repository = new IndexRepository(pool, env), space = embeddingSpace(env);
  app.post('/v1/documents/:id/index', { onRequest: resolveWorkspace }, async (request, reply) => {
    empty.parse(request.query);
    const { id } = params.parse(request.params), body = start.parse(request.body ?? {}), key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).parse(request.headers['idempotency-key'] ?? randomUUID());
    const run = await repository.enqueue(principal(request, true), id, key, body.reindex);
    return reply.code(202).header('Location', '/v1/documents/' + id + '/index').send(indexingAcceptedSchema.parse({ document_id: run.document_id, run_id: run.id, job_id: run.processing_job_id, status: run.status, space_id: run.space_id }));
  });
  app.get('/v1/documents/:id/index', { onRequest: resolveWorkspace }, async (request) => { empty.parse(request.query); return repository.status(principal(request), params.parse(request.params).id); });
  app.get('/v1/search', { onRequest: resolveWorkspace }, async (request) => {
    const context = principal(request), input = searchQuerySchema.parse(request.query);
    const vector = ['semantic', 'hybrid'].includes(input.mode) ? (await client.embed(context.tenantId, [input.q], 'query'))[0] ?? null : null;
    return searchDocuments(pool, context, space, input, vector);
  });
}
