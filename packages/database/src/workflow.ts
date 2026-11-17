import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pageCursorSchema, invoiceCorrectionSchema, financialRulesSchema } from '@doc/contracts';
import type { z } from 'zod';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction } from './transactions.js';
import type { TenantContext } from './transactions.js';
import { readFinancialInvoice, FinancialRepository } from './financial.js';
import { IndexRepository } from './search.js';
import { enqueueInvoiceExtractions } from './extraction.js';
type Page = {
  limit: number;
  cursor?: string | undefined;
};
export function decodePage(cursor?: string) {
  if (!cursor)
    return null;
  try {
    return pageCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  }
  catch {
    throw new ServiceError('INVALID_CURSOR', 400, 'Invalid pagination cursor.');
  }
}
function paginated(rows: pg.QueryResultRow[], limit: number) {
  const items = rows.slice(0, limit), last = items.at(-1);
  return { items, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ created_at: last.precise_created_at, id: last.id })).toString('base64url') : null };
}
const precise = "to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS precise_created_at";
export class WorkflowRepository {
  constructor(private readonly pool: pg.Pool, private readonly env: RuntimeEnvironment) { }
  async correct(context: TenantContext, id: string, input: z.infer<typeof invoiceCorrectionSchema>) {
    return withTenantTransaction(this.pool, context, async (client) => {
      const row = (await client.query('SELECT revision,source_document_id FROM public.invoices WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row)
        throw new ServiceError('INVOICE_NOT_FOUND', 404, 'Invoice not found.');
      if (row.revision !== input.revision)
        throw new ServiceError('INVOICE_REVISION_CONFLICT', 409, 'Reload the invoice before correcting it.');
      await client.query("UPDATE public.documents SET metadata=jsonb_set(metadata,'{workflow}','{\"enabled\":true}') WHERE id=$1", [row.source_document_id]);
      for (const line of input.line_items ?? []) {
        const entries = Object.entries(line.changes), allowed = new Set(['description', 'quantity', 'unit_price', 'tax_rate', 'line_total']);
        if (entries.some(([field]) => !allowed.has(field)))
          throw new ServiceError('INVALID_CORRECTION', 400, 'Unsupported line field.');
        const result = await client.query('UPDATE public.invoice_line_items SET ' + entries.map(([field], index) => field + '=$' + (index + 4)).join(',') + ' WHERE invoice_id=$1 AND id=$2 AND revision=$3 RETURNING id', [id, line.id, line.revision, ...entries.map(([, value]) => value)]);
        if (!result.rowCount)
          throw new ServiceError('LINE_REVISION_CONFLICT', 409, 'Line unavailable or changed; reload the invoice.');
      }
      const entries = Object.entries(input.changes ?? {}), allowed = new Set(['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency']);
      if (entries.some(([field]) => !allowed.has(field)))
        throw new ServiceError('INVALID_CORRECTION', 400, 'Unsupported correction field.');
      await client.query('UPDATE public.invoices SET ' + (entries.length ? entries.map(([field], index) => field + '=$' + (index + 2)).join(',') : "review_status='needs_review'") + ' WHERE id=$1', [id, ...entries.map(([, value]) => value)]);
      const invoice = await readFinancialInvoice(client, id);
      const jobs = (await client.query("SELECT id,status FROM public.processing_jobs WHERE idempotency_key=$1", ['workflow:correction:invoices:' + id + ':' + invoice.revision])).rows;
      return { invoice, workflow_job: jobs[0] ?? null };
    });
  }
  async history(context: TenantContext, id: string, page: Page) {
    const cursor = decodePage(page.cursor);
    return withTenantTransaction(this.pool, context, async (client) => {
      await readFinancialInvoice(client, id);
      const rows = (await client.query(`SELECT id,entity_table,entity_id,actor_user_id,(SELECT u.display_name FROM public.users u WHERE u.id=public.audit_events.actor_user_id) AS actor_name,change_reason AS reason,created_at,${precise},before_data::text AS before_json,after_data::text AS after_json,event_type
        FROM public.audit_events WHERE (entity_id=$1 OR (entity_table='invoice_line_items' AND entity_id IN (SELECT id FROM public.invoice_line_items WHERE invoice_id=$1))) AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, [id, cursor?.created_at ?? null, cursor?.id ?? null, page.limit + 1])).rows;
      return paginated(rows, page.limit);
    });
  }
  async result(context: TenantContext, id: string, page: Page) {
    const cursor = decodePage(page.cursor);
    return withTenantTransaction(this.pool, context, async (client) => {
      const document = (await client.query("SELECT id,processing_status,document_type,page_count,metadata FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
      if (!document)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const rows = (await client.query(`SELECT i.id,i.created_at,e.provider,e.model_id,e.model_version,e.prompt_version,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_created_at FROM public.invoices i
        LEFT JOIN public.extraction_runs e ON (e.tenant_id,e.id)=(i.tenant_id,i.extraction_run_id) AND e.status='succeeded'
        LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id)
        WHERE i.source_document_id=$1 AND (i.source_candidate_id IS NULL OR (c.understanding_run_id::text=$5 AND NOT EXISTS(SELECT 1 FROM public.invoices n WHERE n.source_candidate_id=i.source_candidate_id AND (n.created_at,n.id)>(i.created_at,i.id))))
        AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2::timestamptz,$3::uuid)) ORDER BY i.created_at DESC,i.id DESC LIMIT $4`, [id, cursor?.created_at ?? null, cursor?.id ?? null, Math.min(page.limit, 20) + 1, document.metadata.understanding?.runId ?? null])).rows;
      const selected = paginated(rows, Math.min(page.limit, 20)), invoices = [];
      for (const row of selected.items)
        invoices.push(await readFinancialInvoice(client, row.id));
      return {
        document_id: id, status: document.processing_status, document_type: document.document_type, page_count: document.page_count,
        processing: document.metadata.processing ?? null, understanding: document.metadata.understanding ?? null, invoices, provenance:Object.fromEntries(selected.items.map(row=>[row.id,{provider:row.provider??null,model_id:row.model_id??null,model_version:row.model_version??null,prompt_version:row.prompt_version??null}])), next_cursor: selected.next_cursor
      };
    }, { isolationLevel: 'repeatable read' });
  }
  async status(context: TenantContext, id: string, page: Page) {
    const cursor = decodePage(page.cursor);
    return withTenantTransaction(this.pool, context, async (client) => {
      const document = (await client.query("SELECT id,processing_status FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
      if (!document)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const rows = (await client.query(`SELECT id,job_type,status,attempts,max_attempts,last_error_code,progress,checkpoint,created_at,finished_at,${precise} FROM public.processing_jobs
        WHERE document_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, [id, cursor?.created_at ?? null, cursor?.id ?? null, page.limit + 1])).rows;
      const summary = (await client.query('SELECT status,count(*)::integer AS count FROM public.processing_jobs WHERE document_id=$1 GROUP BY status', [id])).rows;
      return { document_id: id, status: document.processing_status, jobs: paginated(rows, page.limit), job_counts: summary, poll_after_ms: 2000 };
    }, { isolationLevel: 'repeatable read' });
  }
  async reviews(context: TenantContext, page: Page) {
    const cursor = decodePage(page.cursor);
    return withTenantTransaction(this.pool, context, async (client) => {
      const rows = (await client.query(`WITH review AS (
        SELECT i.id,i.created_at,'invoice' AS kind,i.source_document_id AS document_id,jsonb_build_object('invoice_number',i.invoice_number,'revision',i.revision,'review_status',i.review_status) AS summary FROM public.invoices i
        JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id) LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id)
        WHERE NOT (d.metadata ? 'deleted') AND i.review_status IN ('pending','needs_review') AND (i.source_candidate_id IS NULL OR (c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' AND NOT EXISTS(SELECT 1 FROM public.invoices n WHERE n.source_candidate_id=i.source_candidate_id AND (n.created_at,n.id)>(i.created_at,i.id))))
        UNION ALL SELECT j.id,j.created_at,'failed_job',j.document_id,jsonb_build_object('job_type',j.job_type,'error_code',j.last_error_code) FROM public.processing_jobs j JOIN public.documents d ON (d.tenant_id,d.id)=(j.tenant_id,j.document_id) WHERE NOT (d.metadata ? 'deleted') AND j.status='failed'
        UNION ALL SELECT c.id,c.created_at,'candidate',c.document_id,jsonb_build_object('document_type',c.document_type,'requires_manual_review',true) FROM public.invoice_candidates c JOIN public.documents d ON (d.tenant_id,d.id)=(c.tenant_id,c.document_id) WHERE NOT (d.metadata ? 'deleted') AND c.requires_manual_review AND c.understanding_run_id::text=d.metadata#>>'{understanding,runId}'
        UNION ALL SELECT v.id,v.created_at,'validation_issue',v.document_id,jsonb_build_object('code',v.issue_code,'severity',v.severity,'invoice_id',v.invoice_id) FROM public.validation_issues v JOIN public.documents d ON (d.tenant_id,d.id)=(v.tenant_id,v.document_id)
          WHERE NOT (d.metadata ? 'deleted') AND v.resolution_status='open' AND v.manual_review_required AND (v.financial_validation_run_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.financial_validation_runs n JOIN public.financial_validation_runs original ON original.id=v.financial_validation_run_id WHERE n.invoice_id=original.invoice_id AND (n.created_at,n.id)>(original.created_at,original.id)))
      ) SELECT *,${precise} FROM review WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3`, [cursor?.created_at ?? null, cursor?.id ?? null, page.limit + 1])).rows;
      return paginated(rows, page.limit);
    });
  }
  async retry(context: TenantContext, id: string, key: string) {
    return withTenantTransaction(this.pool, context, async (client) => {
      const old = (await client.query('SELECT * FROM public.processing_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old)
        throw new ServiceError('JOB_NOT_FOUND', 404, 'Job not found.');
      if (old.status !== 'failed' || !['ingest', 'extract', 'index', 'workflow'].includes(old.job_type))
        throw new ServiceError('JOB_NOT_RETRYABLE', 409, 'Only supported failed jobs may be retried.');
      const replay = (await client.query("SELECT id,status FROM public.processing_jobs WHERE parent_job_id=$1 AND job_type='workflow' AND (idempotency_key=$2 OR status IN ('pending','running','retry_wait')) ORDER BY created_at DESC LIMIT 1", [id, 'workflow:retry:' + id + ':' + key])).rows[0];
      if (replay)
        return replay;
      if (old.job_type === 'ingest' && (await client.query("SELECT id FROM public.processing_jobs WHERE document_id=$1 AND job_type='ingest' AND status='succeeded' AND created_at>$2 LIMIT 1", [old.document_id, old.created_at])).rowCount)
        throw new ServiceError('JOB_SUPERSEDED', 409, 'A newer source processing job succeeded.');
      return (await client.query("INSERT INTO public.processing_jobs(tenant_id,document_id,parent_job_id,job_type,pipeline_version,idempotency_key,max_attempts,payload) VALUES($1,$2,$3,'workflow','workflow-v1',$4,5,'{\"kind\":\"retry\"}') RETURNING id,status", [context.tenantId, old.document_id, id, 'workflow:retry:' + id + ':' + key])).rows[0];
    });
  }
  async execute(job: pg.QueryResultRow, progress: (stage: string) => Promise<void> = async () => { }): Promise<void | 'waiting'> {
    const context = { tenantId: job.tenant_id, reason: 'Execute durable document workflow' };
    if (job.payload.kind === 'retry') {
      const old = await withTenantTransaction(this.pool, context, async (client) => (await client.query('SELECT * FROM public.processing_jobs WHERE id=$1', [job.parent_job_id])).rows[0]);
      if (!old || old.status !== 'failed')
        throw new ServiceError('JOB_NOT_RETRYABLE', 409, 'Source job is no longer retryable.');
      if (old.job_type === 'ingest') {
        await withTenantTransaction(this.pool, context, async (client) => {
          const doc = (await client.query('SELECT processing_status FROM public.documents WHERE id=$1 FOR UPDATE', [job.document_id])).rows[0];
          if (['rejected', 'cancelled'].includes(doc.processing_status))
            throw new ServiceError('DOCUMENT_NOT_RETRYABLE', 409, 'Document cannot be retried.');
          const id = randomUUID();
          const inserted = await client.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,parent_job_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,max_attempts,payload,dispatch_state,dispatch_max_failures) VALUES($1,$2,$3,$4,'ingest',$5,$6,'document-queue',$1::uuid::text,$7,$8,'pending',$9) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id", [id, job.tenant_id, job.document_id, old.id, old.pipeline_version, 'recovery:' + job.id, old.max_attempts, JSON.stringify({ ...old.payload, jobId: id }), this.env.OUTBOX_MAX_FAILURES]);
          if (inserted.rowCount)
            await client.query("UPDATE public.documents SET processing_status='queued' WHERE id=$1", [job.document_id]);
        });
        return;
      }
      if (old.job_type === 'extract') {
        if (!this.env.CLOUD_LLM_ENABLED && !this.env.LOCAL_LLM_BASE_URL)
          throw new ServiceError('EXTRACTION_NOT_CONFIGURED', 503, 'Configure an approved extraction provider before recovery.');
        await withTenantTransaction(this.pool, context, client => enqueueInvoiceExtractions(client, { tenantId: job.tenant_id, documentId: job.document_id, candidateId: old.extraction_candidate_id, configured: this.env.CLOUD_LLM_ENABLED || !!this.env.LOCAL_LLM_BASE_URL, requestKey: 'recovery-' + job.id, maxDispatchFailures: this.env.OUTBOX_MAX_FAILURES }));
        return;
      }
      if (old.job_type === 'index') {
        await new IndexRepository(this.pool, this.env).enqueue(context, job.document_id, 'recovery-' + job.id, true);
        return;
      }
      if (old.job_type === 'workflow' && old.payload.kind === 'retry')
        return this.execute({ ...job, parent_job_id: old.parent_job_id }, progress);
    }
    const jobs = await withTenantTransaction(this.pool, context, async (client) => {
      const doc = (await client.query('SELECT metadata,processing_status FROM public.documents WHERE id=$1 FOR UPDATE', [job.document_id])).rows[0];
      if (!doc?.metadata.processing?.sourceVersion)
        throw new ServiceError('SOURCE_NOT_READY', 409, 'Normalized source is not available.');
      if (doc.metadata.understanding?.runId)
        await enqueueInvoiceExtractions(client, { tenantId: job.tenant_id, documentId: job.document_id, configured: this.env.CLOUD_LLM_ENABLED || !!this.env.LOCAL_LLM_BASE_URL, maxDispatchFailures: this.env.OUTBOX_MAX_FAILURES });
      return (await client.query("SELECT DISTINCT ON (extraction_candidate_id) status FROM public.processing_jobs WHERE document_id=$1 AND job_type='extract' AND source_understanding_run_id::text=$2 ORDER BY extraction_candidate_id,created_at DESC,id DESC", [job.document_id, doc.metadata.understanding?.runId ?? null])).rows;
    });
    if (jobs.some(row => ['pending', 'queued', 'running', 'retry_wait'].includes(row.status)))
      return 'waiting';
    await progress('financial_validation');
    const invoiceIds = await withTenantTransaction(this.pool, context, async (client) => (await client.query(`SELECT i.id FROM public.invoices i JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id)
      LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id) WHERE i.source_document_id=$1
      AND (i.source_candidate_id IS NULL OR (c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' AND NOT EXISTS(SELECT 1 FROM public.invoices n WHERE n.source_candidate_id=i.source_candidate_id AND (n.created_at,n.id)>(i.created_at,i.id)))) ORDER BY i.id LIMIT 101`, [job.document_id])).rows);
    if (invoiceIds.length > 100)
      throw new ServiceError('WORKFLOW_INVOICE_LIMIT', 413, 'Workflow supports at most 100 invoices per document.');
    if (!invoiceIds.length && !this.env.CLOUD_LLM_ENABLED && !this.env.LOCAL_LLM_BASE_URL) {
      const needsExtraction = await withTenantTransaction(this.pool, context, async (client) => (await client.query("SELECT c.id FROM public.invoice_candidates c JOIN public.documents d ON (d.tenant_id,d.id)=(c.tenant_id,c.document_id) WHERE c.document_id=$1 AND c.document_type='invoice' AND c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' LIMIT 1", [job.document_id])).rowCount);
      if (needsExtraction)
        throw new ServiceError('EXTRACTION_NOT_CONFIGURED', 503, 'Configure an approved extraction provider to continue.');
    }
    const finance = new FinancialRepository(this.pool);
    for (const invoice of invoiceIds) {
      const history = await finance.validationHistory(context, invoice.id, 1);
      if (!history.runs[0]?.is_current)
        await finance.validate(context, invoice.id, 'workflow-' + job.id, history.runs[0]?.rules ?? financialRulesSchema.parse({}));
    }
    await progress('reconciliation');
    const pairs = await withTenantTransaction(this.pool, context, async (client) => (await client.query("SELECT DISTINCT ON (left_document_id,right_document_id) left_document_id,right_document_id,configuration AS rules FROM public.reconciliation_runs WHERE left_document_id=$1 OR right_document_id=$1 ORDER BY left_document_id,right_document_id,created_at DESC LIMIT 51", [job.document_id])).rows);
    if (pairs.length > 50)
      throw new ServiceError('WORKFLOW_RECONCILIATION_LIMIT', 413, 'Too many reconciliation pairs.');
    for (const pair of pairs)
      await finance.reconcile(context, pair.left_document_id, pair.right_document_id, 'workflow-' + job.id + '-' + pair.left_document_id + '-' + pair.right_document_id, financialRulesSchema.parse(pair.rules ?? {}));
    await progress('indexing_dispatch');
    if (this.env.EMBEDDINGS_ENABLED)
      await new IndexRepository(this.pool, this.env).enqueue(context, job.document_id, 'workflow-' + job.id, false);
    if (jobs.some(row => row.status === 'failed'))
      throw new ServiceError('EXTRACTION_REQUIRES_RECOVERY', 409, 'Extraction failed; retry its failed job.');
  }
}
