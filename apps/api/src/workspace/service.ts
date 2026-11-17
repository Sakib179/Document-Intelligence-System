import type pg from 'pg';
import { z } from 'zod';
import { FinancialRepository, withTenantTransaction, decodePage } from '@doc/database';
import type { TenantContext } from '@doc/database';
import { ServiceError } from '@doc/core';
import { documentDto } from '../ingestion/repository.js';
import type { DocumentRow } from '../ingestion/repository.js';
export const workspaceListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(512).optional(), status: z.enum(['uploading', 'uploaded', 'queued', 'processing', 'ingested', 'processed', 'partially_processed', 'needs_review', 'failed', 'rejected', 'cancelled']).optional(), type: z.string().max(40).optional(), q: z.string().max(200).optional(), provider: z.enum(['gemini', 'local_qwen']).optional() }).strict();
const current = `(i.source_candidate_id IS NULL OR (c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' AND NOT EXISTS(SELECT 1 FROM public.invoices n WHERE n.tenant_id=i.tenant_id AND n.source_candidate_id=i.source_candidate_id AND (n.created_at,n.id)>(i.created_at,i.id))))`;
const precision = `to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_created_at`;
export class WorkspaceService {
  constructor(private pool: pg.Pool) { }
  tx<T>(context: TenantContext, action: (client: pg.PoolClient) => Promise<T>) { return withTenantTransaction(this.pool, context, action); }
  async me(context: TenantContext) {
    return this.tx(context, async (client) => {
      const row = (await client.query('SELECT u.id,u.display_name,u.email,u.role,t.id AS tenant_id,t.name AS tenant_name FROM public.users u JOIN public.tenants t ON t.id=u.tenant_id WHERE u.id=$1', [context.actorUserId])).rows[0];
      if (!row)
        throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'Workspace operator is unavailable.');
      return row;
    });
  }
  async dashboard(context: TenantContext) {
    return this.tx(context, async (client) => {
      const counts = (await client.query(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE processing_status IN ('processed','needs_review'))::integer AS completed,count(*) FILTER(WHERE processing_status IN ('uploading','uploaded','queued','processing','ingested'))::integer AS processing,count(*) FILTER(WHERE processing_status IN ('failed','rejected'))::integer AS failed,count(*) FILTER(WHERE processing_status='partially_processed')::integer AS partial FROM public.documents WHERE NOT (metadata ? 'deleted')`)).rows[0];
      const review = (await client.query(`SELECT count(*)::integer AS count FROM public.invoices i JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id) LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id) WHERE NOT (d.metadata ? 'deleted') AND i.review_status IN ('pending','needs_review') AND ${current}`)).rows[0].count;
      const activity = (await client.query("SELECT j.id,j.document_id,j.job_type,j.status,j.progress,j.last_error_code,j.updated_at,d.original_filename FROM public.processing_jobs j JOIN public.documents d ON (d.tenant_id,d.id)=(j.tenant_id,j.document_id) WHERE NOT (d.metadata ? 'deleted') ORDER BY j.updated_at DESC,j.id DESC LIMIT 10")).rows;
      return { counts: { ...counts, review_required_invoices: review }, activity:activity.map(row=>({...row,updated_at:row.updated_at.toISOString()})), checked_at: new Date().toISOString() };
    });
  }
  async documents(context: TenantContext, input: z.infer<typeof workspaceListQuery>) {
    const cursor = decodePage(input.cursor);
    const rows = await this.tx(context, async (client) => (await client.query(`SELECT d.*,${precision},e.provider,e.model_id,
      ARRAY(SELECT i.id FROM public.invoices i LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id) WHERE i.source_document_id=d.id AND ${current} ORDER BY i.id LIMIT 21) AS invoice_ids
      FROM public.documents d LEFT JOIN LATERAL(SELECT provider,model_id FROM public.extraction_runs WHERE document_id=d.id AND status='succeeded' AND (understanding_run_id IS NULL OR understanding_run_id::text=d.metadata#>>'{understanding,runId}') ORDER BY created_at DESC,id DESC LIMIT 1)e ON true
      WHERE NOT (d.metadata ? 'deleted') AND ($1::timestamptz IS NULL OR (d.created_at,d.id)<($1::timestamptz,$2::uuid)) AND ($3::text IS NULL OR d.processing_status=$3) AND ($4::text IS NULL OR d.document_type=$4) AND ($5::text IS NULL OR position(lower($5) IN lower(d.original_filename))>0) AND ($6::text IS NULL OR e.provider=$6)
      ORDER BY d.created_at DESC,d.id DESC LIMIT $7`, [cursor?.created_at ?? null, cursor?.id ?? null, input.status ?? null, input.type ?? null, input.q ?? null, input.provider ?? null, input.limit + 1])).rows);
    const page = rows.slice(0, input.limit), documents = [];
    const finance = new FinancialRepository(this.pool);
    for (const row of page) {
      let validation = 'NOT_VALIDATED', stale = false;
      for (const id of row.invoice_ids.slice(0, 20)) {
        const result = await finance.validationHistory(context, id, 1);
        const next = result.financial_status ?? 'NOT_VALIDATED';
        stale ||= result.stale;
        const rank: Record<string, number> = { NOT_VALIDATED: 0, VALID: 1, WARNING: 2, REVIEW_REQUIRED: 3 };
        if ((rank[next] ?? 0) > (rank[validation] ?? 0))
          validation = next;
      }
      if (row.invoice_ids.length > 20) {
        validation = 'REVIEW_REQUIRED';
        stale = true;
      }
      documents.push({ ...documentDto(row as DocumentRow), validation_status: validation, validation_stale: stale, provider: row.provider ?? null, model_id: row.model_id ?? null });
    }
    const last = page.at(-1);
    return { documents, next_cursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({ created_at: last.precise_created_at, id: last.id })).toString('base64url') : null };
  }
  async document(context: TenantContext, id: string) {
    return this.tx(context, async (client) => {
      const row = (await client.query("SELECT * FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
      if (!row)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      return row;
    });
  }
  async deleteDocument(context: TenantContext, id: string) {
    return this.tx(context, async (client) => {
      const row = (await client.query<{ id: string; tenant_id: string; object_storage_key: string }>(
        "SELECT id,tenant_id,object_storage_key FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted') FOR UPDATE",
        [id],
      )).rows[0];
      if (!row)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      await client.query(
        `UPDATE public.documents
         SET processing_status='cancelled',
             search_generation=search_generation+1,
             metadata=metadata || jsonb_build_object(
               'deleted', jsonb_build_object('deletedAt', clock_timestamp(), 'deletedBy', $2::text, 'reason', $3::text),
               'workflow', COALESCE(metadata->'workflow', '{}'::jsonb) || '{"enabled":false}'::jsonb
             )
         WHERE id=$1`,
        [id, context.actorUserId ?? null, context.reason ?? 'Deleted document from workspace'],
      );
      await client.query(
        `UPDATE public.processing_jobs
         SET status='cancelled',
             finished_at=clock_timestamp(),
             dispatch_state=CASE WHEN dispatch_state='not_applicable' THEN 'not_applicable' ELSE 'dead' END,
             dispatch_lease_token=NULL,
             dispatch_lease_until=NULL,
             execution_lease_token=NULL,
             execution_lease_until=NULL
         WHERE document_id=$1 AND status IN ('pending','queued','running','retry_wait')`,
        [id],
      );
      await client.query(
        "UPDATE public.extraction_runs SET status='cancelled',finished_at=clock_timestamp() WHERE document_id=$1 AND status IN ('pending','running')",
        [id],
      );
      await client.query(
        "UPDATE public.indexing_runs SET status='cancelled',finished_at=clock_timestamp() WHERE document_id=$1 AND status IN ('pending','running')",
        [id],
      );
      return row;
    });
  }
  async pages(context: TenantContext, id: string, limit: number, cursor?: string) {
    return this.tx(context, async (client) => {
      const doc = (await client.query("SELECT metadata FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
      if (!doc)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const version = doc.metadata.processing?.sourceVersion;
      if (!version)
        return { pages: [], next_cursor: null };
      let after = 0;
      if (cursor) {
        try {
          const decoded = z.object({ version: z.number().int(), page: z.number().int().nonnegative() }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
          if (decoded.version !== version)
            throw new ServiceError('SOURCE_CHANGED', 409, 'Source version changed; reload pages.');
          after = decoded.page;
        }
        catch (error) {
          if (error instanceof ServiceError)
            throw error;
          throw new ServiceError('INVALID_CURSOR', 400, 'Invalid source cursor.');
        }
      }
      const rows = (await client.query('SELECT page_number,source_kind,worksheet_name,extraction_method,ocr_confidence::text FROM public.document_pages WHERE document_id=$1 AND source_version=$2 AND page_number>$3 ORDER BY page_number LIMIT $4', [id, version, after, limit + 1])).rows;
      const pages = rows.slice(0, limit), last = pages.at(-1);
      return { pages, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ version, page: last.page_number })).toString('base64url') : null };
    });
  }
  async page(context: TenantContext, id: string, number: number, after: number) {
    return this.tx(context, async (client) => {
      const page = (await client.query("SELECT p.id,p.page_number,p.source_kind,p.worksheet_name,p.extraction_method,p.ocr_confidence::text,p.extracted_text,p.coordinate_system,p.width,p.height,p.source_reference FROM public.document_pages p JOIN public.documents d ON (d.tenant_id,d.id)=(p.tenant_id,p.document_id) WHERE NOT (d.metadata ? 'deleted') AND p.document_id=$1 AND p.page_number=$2 AND p.source_version=(d.metadata#>>'{processing,sourceVersion}')::integer", [id, number])).rows[0];
      if (!page)
        throw new ServiceError('PAGE_NOT_FOUND', 404, 'Source page not found.');
      const blocks = (await client.query('SELECT block_number,block_type,extracted_text,ocr_confidence::text,bounding_box,coordinate_system,table_data,source_reference FROM public.document_blocks WHERE page_id=$1 AND block_number>$2 ORDER BY block_number LIMIT 101', [page.id, after])).rows;
      return { ...page, blocks: blocks.slice(0, 100), next_after: blocks.length > 100 ? blocks[99].block_number : null };
    });
  }
  async reconciliations(context: TenantContext, limit: number, cursor?: string) {
    const after = decodePage(cursor);
    return this.tx(context, async (client) => {
      const rows = (await client.query(`SELECT r.id,r.left_document_id,r.right_document_id,r.financial_status,r.reconciliation_type,r.created_at,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS precise_created_at,l.original_filename AS left_filename,d.original_filename AS right_filename FROM public.reconciliation_runs r JOIN public.documents l ON (l.tenant_id,l.id)=(r.tenant_id,r.left_document_id) JOIN public.documents d ON (d.tenant_id,d.id)=(r.tenant_id,r.right_document_id) WHERE NOT (l.metadata ? 'deleted') AND NOT (d.metadata ? 'deleted') AND ($1::timestamptz IS NULL OR (r.created_at,r.id)<($1::timestamptz,$2::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT $3`, [after?.created_at ?? null, after?.id ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map(row=>({...row,created_at:row.created_at.toISOString()})), last = items.at(-1);
      return { items, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ created_at: last.precise_created_at, id: last.id })).toString('base64url') : null };
    });
  }
}
