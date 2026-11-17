import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { FinancialRepository } from '@doc/database';
import { ServiceError } from '@doc/core';
import { validationRequestSchema, financialTermsUpdateSchema, reconciliationRequestSchema, validationRunSchema, reconciliationRunSchema, financialInvoiceSchema, financialStatusSchema, financialTermsSchema } from '@doc/contracts';
const params = z.object({ id: z.uuid() }).strict(), emptyQuery = z.object({}).strict();
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10) }).strict();
const historyResponse = z.object({ invoice: financialInvoiceSchema, financial_status: financialStatusSchema.nullable(), stale: z.boolean(), runs: z.array(validationRunSchema) }).strict();
const termsResponse = z.object({ invoice_id: z.uuid(), revision: z.number().int(), terms: financialTermsSchema }).strict();
const validationResponse = z.object({ replayed: z.boolean(), run: validationRunSchema }).strict();
const reconciliationResponse = z.object({ replayed: z.boolean(), run: reconciliationRunSchema }).strict();
function context(request: FastifyRequest, reason: string, writing = false) {
  if (!request.principal)
    throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.');
  if (writing && request.principal.role === 'reader')
    throw new ServiceError('FORBIDDEN', 403, 'This user cannot create financial results or edit terms.');
  return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason };
}
function key(request: FastifyRequest) { return z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).parse(request.headers['idempotency-key'] ?? randomUUID()); }
export function registerFinancialRoutes(app: FastifyInstance, pool: pg.Pool, resolveWorkspace: (request: FastifyRequest) => Promise<void>) {
  const repository = new FinancialRepository(pool);
  app.patch('/v1/invoices/:id/financial-terms', { onRequest: resolveWorkspace }, async (request) => {
    emptyQuery.parse(request.query);
    const { id } = params.parse(request.params), body = financialTermsUpdateSchema.parse(request.body);
    return termsResponse.parse(await repository.updateTerms(context(request, body.reason, true), id, body.revision, body.terms));
  });
  app.post('/v1/invoices/:id/validations', { onRequest: resolveWorkspace }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const { id } = params.parse(request.params), body = validationRequestSchema.parse(request.body ?? {}), requestKey = key(request);
    const result = validationResponse.parse(await repository.validate(context(request, 'Run deterministic financial validation', true), id, requestKey, body.rules));
    return reply.code(result.replayed ? 200 : 201).header('Idempotency-Key', requestKey).header('Location', '/v1/invoices/' + id + '/validations').send(result);
  });
  app.get('/v1/invoices/:id/validations', { onRequest: resolveWorkspace }, async (request) => {
    const { id } = params.parse(request.params), query = historyQuery.parse(request.query);
    return historyResponse.parse(await repository.validationHistory(context(request, 'Read financial validation snapshots'), id, query.limit));
  });
  app.post('/v1/reconciliations', { onRequest: resolveWorkspace }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const body = reconciliationRequestSchema.parse(request.body), requestKey = key(request);
    const result = reconciliationResponse.parse(await repository.reconcile(context(request, 'Run deterministic cross-document reconciliation', true), body.left_document_id, body.right_document_id, requestKey, body.rules));
    return reply.code(result.replayed ? 200 : 201).header('Idempotency-Key', requestKey).header('Location', '/v1/reconciliations/' + result.run.id).send(result);
  });
  app.get('/v1/reconciliations/:id', { onRequest: resolveWorkspace }, async (request) => {
    emptyQuery.parse(request.query);
    const { id } = params.parse(request.params);
    return reconciliationRunSchema.parse(await repository.getReconciliation(context(request, 'Read reconciliation snapshot'), id));
  });
}
