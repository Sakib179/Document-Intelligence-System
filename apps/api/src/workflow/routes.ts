import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invoiceCorrectionSchema, pageQuerySchema, retryRequestSchema, requestKeySchema } from '@doc/contracts';
import { WorkflowRepository } from '@doc/database';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
const params = z.object({ id: z.uuid() }).strict(), empty = z.object({}).strict();
function context(request: FastifyRequest, writing = false, reason = 'Read document workflow') {
  if (!request.principal)
    throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.');
  if (writing && request.principal.role === 'reader')
    throw new ServiceError('FORBIDDEN', 403, 'Review permission required.');
  return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason };
}
export function registerWorkflowRoutes(app: FastifyInstance, pool: pg.Pool, env: RuntimeEnvironment, resolveWorkspace: (request: FastifyRequest) => Promise<void>) {
  const service = new WorkflowRepository(pool, env);
  app.get('/v1/documents/:id/result', { onRequest: resolveWorkspace }, request => service.result(context(request), params.parse(request.params).id, pageQuerySchema.parse(request.query)));
  app.get('/api/v1/documents/:id/status', { onRequest: resolveWorkspace }, async (request, reply) => {
    reply.header('Retry-After', '2').header('Cache-Control', 'no-store');
    return service.status(context(request), params.parse(request.params).id, pageQuerySchema.parse(request.query));
  });
  app.patch('/v1/invoices/:id', { onRequest: resolveWorkspace }, request => {
    empty.parse(request.query);
    const body = invoiceCorrectionSchema.parse(request.body);
    return service.correct(context(request, true, body.reason ?? 'Manual correction (no reason supplied)'), params.parse(request.params).id, body);
  });
  app.get('/v1/invoices/:id/history', { onRequest: resolveWorkspace }, request => service.history(context(request), params.parse(request.params).id, pageQuerySchema.parse(request.query)));
  app.get('/v1/reviews', { onRequest: resolveWorkspace }, request => service.reviews(context(request), pageQuerySchema.parse(request.query)));
  app.post('/v1/jobs/:id/retry', { onRequest: resolveWorkspace }, async (request, reply) => {
    empty.parse(request.query);
    const body = retryRequestSchema.parse(request.body ?? {}), key = requestKeySchema.parse(request.headers['idempotency-key'] ?? randomUUID());
    const job = await service.retry(context(request, true, body.reason ?? 'Explicit failed-job recovery'), params.parse(request.params).id, key);
    return reply.code(202).header('Idempotency-Key', key).send({ job_id: job.id, status: job.status });
  });
}
