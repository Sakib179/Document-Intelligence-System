import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { documentPrivacySchema, extractionStartSchema, extractionAcceptedSchema, extractionResultsSchema } from '@doc/contracts';
import { withTenantTransaction, enqueueInvoiceExtractions } from '@doc/database';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';

const params = z.object({ id: z.uuid() }).strict();
const noQuery = z.object({}).strict();
const resultQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10), cursor: z.string().max(256).optional() }).strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
function principal(request: FastifyRequest, reason: string) {
  if (!request.principal) throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace context is unavailable.');
  return { tenantId: request.principal.tenantId, actorUserId: request.principal.userId, reason };
}
const invoiceOriginals = "jsonb_build_object('invoice_number',original_values->>'invoice_number','invoice_date',original_values->>'invoice_date','supplier_name',original_values->>'supplier_name','customer_name',original_values->>'customer_name','subtotal',original_values->>'subtotal','tax',original_values->>'tax','total',original_values->>'total','currency',original_values->>'currency') AS original_values";
const lineOriginals = "jsonb_build_object('description',original_values->>'description','quantity',original_values->>'quantity','unit_price',original_values->>'unit_price','tax_rate',original_values->>'tax_rate','line_total',original_values->>'line_total') AS original_values";

export function registerExtractionRoutes(app: FastifyInstance, pool: pg.Pool, environment: RuntimeEnvironment,
  resolveWorkspace: (request: FastifyRequest) => Promise<void>) {
  const configured = environment.CLOUD_LLM_ENABLED || Boolean(environment.LOCAL_LLM_BASE_URL);
  app.patch('/v1/documents/:id/privacy', { onRequest: resolveWorkspace }, async (request) => {
    noQuery.parse(request.query);
    if (request.principal?.role !== 'admin') throw new ServiceError('FORBIDDEN', 403, 'Only a tenant administrator may classify or approve cloud data.');
    const { id } = params.parse(request.params), input = documentPrivacySchema.parse(request.body);
    return withTenantTransaction(pool, principal(request, input.reason), async (client) => {
      const row = (await client.query('UPDATE public.documents SET data_classification=$2,cloud_processing_allowed=$3 WHERE id=$1 RETURNING id,data_classification,cloud_processing_allowed,data_classified_by,data_classified_at,cloud_approved_by,cloud_approved_at', [id, input.data_classification, input.cloud_processing_allowed])).rows[0];
      if (!row) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      return { document_id: row.id, data_classification: row.data_classification, cloud_processing_allowed: row.cloud_processing_allowed,
        data_classified_by: row.data_classified_by, data_classified_at: row.data_classified_at?.toISOString() ?? null,
        cloud_approved_by: row.cloud_approved_by, cloud_approved_at: row.cloud_approved_at?.toISOString() ?? null,
        gemini_permitted: environment.CLOUD_LLM_ENABLED && (['public', 'synthetic'].includes(row.data_classification) || row.cloud_processing_allowed) };
    });
  });

  app.post('/v1/documents/:id/extractions', { onRequest: resolveWorkspace }, async (request, reply) => {
    noQuery.parse(request.query);
    if (request.principal?.role === 'reader') throw new ServiceError('FORBIDDEN', 403, 'This user cannot start extraction.');
    const { id } = params.parse(request.params), input = extractionStartSchema.parse(request.body ?? {});
    const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._-]+$/).parse(request.headers['idempotency-key'] ?? randomUUID());
    const tenant = principal(request, 'Request invoice extraction snapshot');
    const jobs = await withTenantTransaction(pool, tenant, async (client) => {
      const exists = (await client.query('SELECT id FROM public.documents WHERE id=$1', [id])).rowCount;
      if (!exists) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      if (!configured) throw new ServiceError('EXTRACTION_NOT_CONFIGURED', 503, 'Configure an allowed Gemini provider or a private local Qwen endpoint.');
      return enqueueInvoiceExtractions(client, { tenantId: tenant.tenantId, documentId: id, configured, requestKey: key,
        ...(input.candidate_id ? { candidateId: input.candidate_id } : {}), maxDispatchFailures: environment.OUTBOX_MAX_FAILURES });
    });
    if (!jobs.length) throw new ServiceError('NO_ELIGIBLE_INVOICE_CANDIDATES', 409, 'Invoice boundaries require review or no invoice candidates exist.');
    return reply.code(202).header('Location', '/v1/documents/' + id + '/extractions').send(extractionAcceptedSchema.parse({ document_id: id, idempotency_key: key, jobs }));
  });

  app.get('/v1/documents/:id/extractions', { onRequest: resolveWorkspace }, async (request) => {
    const { id } = params.parse(request.params), query = resultQuery.parse(request.query);
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); }
      catch { throw new ServiceError('INVALID_CURSOR', 400, 'Invalid extraction cursor.'); }
    }
    return withTenantTransaction(pool, principal(request, 'Read invoice extraction history'), async (client) => {
      if (!(await client.query('SELECT id FROM public.documents WHERE id=$1', [id])).rowCount) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const rows = (await client.query("SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS precise_created_at FROM public.extraction_runs WHERE document_id=$1 AND candidate_id IS NOT NULL AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4", [id, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1])).rows;
      const selected = rows.slice(0, query.limit), runs = [];
      for (const row of selected) {
        const attempts = (await client.query('SELECT provider,model_id,model_version,prompt_version,attempt_number,status,schema_valid,error_code,processing_time_ms,fallback_used FROM public.extraction_attempts WHERE extraction_run_id=$1 ORDER BY started_at,id', [row.id])).rows;
        const invoice = (await client.query('SELECT id,review_status,invoice_number,invoice_date::text,supplier_name,customer_name,subtotal::text,tax::text,total::text,currency,' + invoiceOriginals + ' FROM public.invoices WHERE extraction_run_id=$1 AND source_candidate_id IS NOT NULL', [row.id])).rows[0];
        if (invoice) invoice.line_items = (await client.query('SELECT id,line_number,description,quantity::text,unit_price::text,tax_rate::text,line_total::text,' + lineOriginals + ' FROM public.invoice_line_items WHERE invoice_id=$1 ORDER BY line_number', [invoice.id])).rows;
        runs.push({ id: row.id, candidate_id: row.candidate_id, status: row.status, provider: row.provider, model_id: row.model_id,
          model_version: row.model_version, prompt_version: row.prompt_version, processing_time_ms: row.processing_time_ms,
          fallback_used: row.fallback_used, schema_valid: row.schema_valid, error_code: row.error_code,
          result: row.structured_result, created_at: row.created_at.toISOString(), attempts, invoice: invoice ?? null });
      }
      const jobs = (await client.query("SELECT id,extraction_candidate_id AS candidate_id,status,last_error_code AS error_code FROM public.processing_jobs WHERE document_id=$1 AND job_type='extract' ORDER BY created_at DESC,id DESC LIMIT 100", [id])).rows;
      const last = selected.at(-1);
      return extractionResultsSchema.parse({ document_id: id, configured, runs, jobs, next_cursor: rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.precise_created_at, id: last.id })).toString('base64url') : null });
    }, { isolationLevel: 'repeatable read' });
  });

  app.get('/v1/providers/health', { onRequest: resolveWorkspace }, async (request) => {
    noQuery.parse(request.query);
    return withTenantTransaction(pool, principal(request, 'Read tenant-scoped provider protocol health'), async (client) => ({
      cloud_enabled: environment.CLOUD_LLM_ENABLED, local_configured: Boolean(environment.LOCAL_LLM_BASE_URL),
      providers: (await client.query("SELECT provider,model_id,consecutive_failures,success_count,failure_count,last_error_code,last_success_at,last_failure_at,circuit_open_until,CASE WHEN circuit_open_until>clock_timestamp() THEN 'open' WHEN last_success_at IS NOT NULL AND (last_failure_at IS NULL OR last_success_at>=last_failure_at) THEN 'healthy' WHEN failure_count>0 THEN 'degraded' ELSE 'unknown' END AS status FROM public.llm_provider_health ORDER BY COALESCE(last_success_at,last_failure_at) DESC NULLS LAST LIMIT 100")).rows,
    }));
  });
}
