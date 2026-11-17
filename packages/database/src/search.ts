import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { indexingPayloadSchema, searchResultSchema, indexingStatusSchema } from '@doc/contracts';
import type { EmbeddingSpace, IndexingPayload, SearchQuery, SearchResult, PreparedChunk, ChunkUnit } from '@doc/contracts';
import { embeddingSpace, ServiceError, validEmbedding } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction } from './transactions.js';
import type { TenantContext } from './transactions.js';
export const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');
type Run = {
  id: string;
  processing_job_id: string;
  document_id: string;
  source_generation: string;
  source_version: number;
  space_id: string;
  configuration: EmbeddingSpace;
  status: string;
};
export class IndexRepository {
  readonly space: EmbeddingSpace;
  constructor(private readonly database: pg.Pool, private readonly env: RuntimeEnvironment) { this.space = embeddingSpace(env); }
  tx<T>(tenantId: string, reason: string, action: (client: pg.PoolClient) => Promise<T>) { return withTenantTransaction(this.database, { tenantId, reason }, action); }
  async enqueue(context: TenantContext, documentId: string, key: string, force: boolean) {
    if (!this.env.EMBEDDINGS_ENABLED)
      throw new ServiceError('EMBEDDINGS_DISABLED', 503, 'Local embeddings are disabled.');
    return withTenantTransaction(this.database, context, async (client) => {
      const document = (await client.query('SELECT * FROM public.documents WHERE id=$1 FOR UPDATE', [documentId])).rows[0];
      if (!document)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const version = document.metadata.processing?.sourceVersion;
      if (!Number.isInteger(version) || version < 1 || !['processed', 'needs_review', 'partially_processed'].includes(document.processing_status))
        throw new ServiceError('SOURCE_NOT_READY', 409, 'Normalize the document before indexing.');
      const replay = (await client.query('SELECT * FROM public.indexing_runs WHERE document_id=$1 AND request_key=$2', [documentId, key])).rows[0];
      if (replay) {
        if (replay.space_id !== this.space.space_id)
          throw new ServiceError('IDEMPOTENCY_CONFLICT', 409, 'This key used another embedding configuration.');
        return replay;
      }
      if (!force) {
        const existing = (await client.query("SELECT * FROM public.indexing_runs WHERE document_id=$1 AND source_generation=$2 AND space_id=$3 AND status IN ('pending','running','succeeded') ORDER BY created_at DESC LIMIT 1", [documentId, document.search_generation, this.space.space_id])).rows[0];
        if (existing)
          return existing;
      }
      const id = randomUUID(), jobId = randomUUID();
      const payload: IndexingPayload = { schemaVersion: 1, stage: 'index', jobId, tenantId: context.tenantId.toLowerCase(), documentId: document.id, runId: id };
      await client.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,payload,max_attempts,dispatch_state,dispatch_max_failures) VALUES($1,$2,$3,'index','local-search-v1',$4,'indexing-queue',$1::uuid::text,$5,3,'pending',$6)", [jobId, context.tenantId, documentId, 'index:' + id, JSON.stringify(payload), this.env.OUTBOX_MAX_FAILURES]);
      return (await client.query('INSERT INTO public.indexing_runs(id,tenant_id,document_id,processing_job_id,requested_by,request_key,source_generation,source_version,space_id,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [id, context.tenantId, documentId, jobId, context.actorUserId ?? null, key, document.search_generation, version, this.space.space_id, JSON.stringify(this.space)])).rows[0];
    });
  }
  async status(context: TenantContext, documentId: string) {
    return withTenantTransaction(this.database, context, async (client) => {
      const document = (await client.query('SELECT search_generation,metadata FROM public.documents WHERE id=$1', [documentId])).rows[0];
      if (!document)
        throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      const runs = (await client.query('SELECT id,status,space_id,source_generation,source_version,chunk_count,cache_hits,error_code,created_at,finished_at FROM public.indexing_runs WHERE document_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [documentId])).rows;
      const head = document.metadata.search ?? null;
      return indexingStatusSchema.parse({
        document_id: documentId, active_space: this.space, current_generation: document.search_generation, head, is_current: head?.spaceId === this.space.space_id && head?.generation === document.search_generation,
        runs: runs.map(run => ({ ...run, created_at: run.created_at.toISOString(), finished_at: run.finished_at?.toISOString() ?? null }))
      });
    });
  }
  async claim(payload: IndexingPayload) {
    return this.tx(payload.tenantId, 'Claim local indexing execution', async (client) => {
      const run = (await client.query('SELECT r.*,j.payload,j.status AS job_status,j.attempts,j.max_attempts,j.execution_lease_until FROM public.indexing_runs r JOIN public.processing_jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.processing_job_id) WHERE r.id=$1 AND r.document_id=$2 AND j.id=$3 FOR UPDATE OF r,j', [payload.runId, payload.documentId, payload.jobId])).rows[0];
      if (!run || JSON.stringify(indexingPayloadSchema.parse(run.payload)) !== JSON.stringify(payload))
        throw new ServiceError('INDEX_REFERENCE_MISMATCH', 422, 'Invalid indexing references.');
      if (['succeeded', 'failed', 'cancelled'].includes(run.status))
        return { done: true as const };
      if (run.execution_lease_until && new Date(run.execution_lease_until) > new Date())
        return { defer: new Date(run.execution_lease_until).getTime() + 100 };
      if (run.space_id !== this.space.space_id || run.attempts >= run.max_attempts)
        throw new ServiceError('INDEX_CONFIGURATION_CHANGED', 422, 'Re-index with the current embedding model.');
      const token = randomUUID();
      await client.query("UPDATE public.processing_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,execution_lease_token=$2,execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1", [payload.jobId, token]);
      await client.query("UPDATE public.indexing_runs SET status='running' WHERE id=$1", [run.id]);
      return { run: run as Run, token };
    });
  }
  async heartbeat(payload: IndexingPayload, token: string) { await this.tx(payload.tenantId, 'Renew indexing lease', client => client.query("UPDATE public.processing_jobs SET execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1 AND execution_lease_token=$2 AND status='running'", [payload.jobId, token])); }
  private async fence(client: pg.PoolClient, payload: IndexingPayload, token: string) {
    const row = (await client.query('SELECT j.id,d.search_generation,r.source_generation FROM public.processing_jobs j JOIN public.indexing_runs r ON r.processing_job_id=j.id AND r.tenant_id=j.tenant_id JOIN public.documents d ON (d.tenant_id,d.id)=(r.tenant_id,r.document_id) WHERE j.id=$1 AND j.execution_lease_token=$2 AND j.status=\'running\' FOR UPDATE OF j,d', [payload.jobId, token])).rows[0]; if (!row || row.search_generation !== row.source_generation)
      throw new ServiceError('INDEX_SOURCE_CHANGED', 409, 'Source changed during indexing.');
  }
  async cached(tenant: string, texts: string[]) {
    return this.tx(tenant, 'Read tenant-scoped embedding cache', async (client) => {
      const rows = (await client.query("SELECT DISTINCT ON (embedding_configuration->>'content_sha256') embedding_configuration->>'content_sha256' AS hash,embedding::text AS vector FROM public.document_chunks WHERE embedding_configuration->>'space_id'=$1 AND embedding_configuration->>'content_sha256'=ANY($2::text[]) AND embedding IS NOT NULL", [this.space.space_id, texts.map(textDigest)])).rows;
      return new Map<string, number[]>(rows.map(row => [row.hash, JSON.parse(row.vector)]));
    });
  }
  async append(payload: IndexingPayload, run: Run, token: string, start: number, chunks: PreparedChunk[], vectors: number[][]) {
    if (vectors.length !== chunks.length || !vectors.every(validEmbedding))
      throw new ServiceError('INVALID_INDEX_VECTORS', 502, 'Invalid embedding vectors.');
    await this.tx(payload.tenantId, 'Append immutable indexed evidence', async (client) => {
      await this.fence(client, payload, token);
      for (const [offset, chunk] of chunks.entries())
        await client.query(`INSERT INTO public.document_chunks(tenant_id,document_id,invoice_id,chunk_number,source_version,chunk_text,source_reference,embedding,embedding_model_id,embedding_model_version,embedding_configuration,embedded_at,indexing_run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,clock_timestamp(),$12) ON CONFLICT DO NOTHING`, [payload.tenantId, payload.documentId, chunk.invoice_id, start + offset, run.source_version, chunk.chunk_text,
        JSON.stringify({ page_number: chunk.page_number, worksheet: chunk.worksheet, section: chunk.section, token_count: chunk.token_count, sources: chunk.source_references, source_version: run.source_version }), JSON.stringify(vectors[offset]), this.space.model_id, this.space.model_version, JSON.stringify({ ...this.space, content_sha256: textDigest(chunk.chunk_text) }), run.id]);
    });
  }
  async finish(payload: IndexingPayload, run: Run, token: string, count: number, hits: number) {
    await this.tx(payload.tenantId, 'Atomically publish complete search generation', async (client) => {
      await this.fence(client, payload, token);
      const actual = (await client.query('SELECT count(*)::integer AS count FROM public.document_chunks WHERE indexing_run_id=$1', [run.id])).rows[0].count;
      if (actual !== count || count === 0)
        throw new ServiceError('INDEX_INCOMPLETE', 422, 'No complete index was generated.');
      await client.query("UPDATE public.indexing_runs SET status='succeeded',finished_at=clock_timestamp(),chunk_count=$2,cache_hits=$3 WHERE id=$1", [run.id, count, hits]);
      await client.query("UPDATE public.documents SET metadata=jsonb_set(metadata,'{search}',$2) WHERE id=$1", [run.document_id, JSON.stringify({ runId: run.id, spaceId: run.space_id, generation: run.source_generation })]);
      await client.query("UPDATE public.processing_jobs SET status='succeeded',finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=NULL,checkpoint=$2 WHERE id=$1", [payload.jobId, JSON.stringify({ stage: 'indexing_complete', runId: run.id, chunks: count })]);
    });
  }
  async fail(payload: IndexingPayload, token: string | undefined, code: string, permanent: boolean) {
    await this.tx(payload.tenantId, 'Persist bounded indexing failure', async (client) => {
      const job = (await client.query("SELECT attempts,max_attempts FROM public.processing_jobs j WHERE id=$1 AND document_id=$3 AND status NOT IN ('succeeded','failed','cancelled') AND EXISTS(SELECT 1 FROM public.indexing_runs r WHERE r.id=$4 AND r.document_id=j.document_id AND r.processing_job_id=j.id) AND ($2::uuid IS NULL OR execution_lease_token=$2) FOR UPDATE", [payload.jobId, token ?? null, payload.documentId, payload.runId])).rows[0];
      if (!job)
        return;
      const terminal = permanent || job.attempts >= job.max_attempts;
      await client.query("UPDATE public.processing_jobs SET status=$2,finished_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$4 WHERE id=$1", [payload.jobId, terminal ? 'failed' : 'retry_wait', terminal, code]);
      if (terminal)
        await client.query("UPDATE public.indexing_runs SET status='failed',finished_at=clock_timestamp(),error_code=$2 WHERE id=$1 AND status IN ('pending','running')", [payload.runId, code]);
    });
  }
  async *units(tenant: string, run: Run): AsyncGenerator<ChunkUnit[]> {
    let pageNumber = 0;
    const seenHeaders = new Set<string>();
    while (true) {
      const page = await this.tx(tenant, 'Read bounded indexing page', async (client) => (await client.query('SELECT id,page_number,source_kind,worksheet_name,extracted_text FROM public.document_pages WHERE document_id=$1 AND source_version=$2 AND page_number>$3 ORDER BY page_number LIMIT 1', [run.document_id, run.source_version, pageNumber])).rows[0]);
      if (!page)
        break;
      pageNumber = page.page_number;
      const invoices = await this.tx(tenant, 'Read active invoice source anchors', async (client) => (await client.query(`SELECT DISTINCT ON (i.source_candidate_id) i.id,i.invoice_number,i.supplier_name,i.customer_name,i.invoice_date::text,i.currency,i.subtotal::text,i.tax::text,i.total::text,c.data FROM public.invoices i
        JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id) JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id)
        WHERE i.source_document_id=$1 AND c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' AND c.data->'source_pages' @> $2::jsonb
        ORDER BY i.source_candidate_id,i.created_at DESC,i.id DESC LIMIT 1001`, [run.document_id, JSON.stringify([pageNumber])])).rows);
      if (invoices.length > 1000)
        throw new ServiceError('INDEX_INVOICE_LIMIT', 422, 'Too many invoice anchors on a page.');
      let units: ChunkUnit[] = [];
      const push = (id: string, text: string, invoice: string | null, cell: string | null, kind: ChunkUnit['kind'] = 'text', section = page.worksheet_name ?? 'Document source') => {
        if (kind === 'header') {
          const normalized = text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
          if (seenHeaders.has(normalized))
            return;
          seenHeaders.add(normalized);
        }
        const characters = Array.from(text);
        for (let start = 0; start < characters.length; start += 18000) {
          const value = characters.slice(start, start + 18000).join('').trim();
          if (value)
            units.push({ unit_id: (id + ':' + start).slice(0, 120), invoice_id: invoice, page_number: pageNumber, worksheet: page.worksheet_name, cell_range: cell, section, kind, text: value });
        }
      };
      for (const invoice of invoices) {
        push('invoice:' + invoice.id, `Current invoice ${invoice.invoice_number ?? 'unknown'} | Supplier ${invoice.supplier_name ?? 'unknown'} | Customer ${invoice.customer_name ?? 'unknown'} | Date ${invoice.invoice_date ?? 'unknown'} | Currency ${invoice.currency ?? 'unknown'} | Subtotal ${invoice.subtotal ?? 'unknown'} | Tax ${invoice.tax ?? 'unknown'} | Total ${invoice.total ?? 'unknown'}`, invoice.id, null, 'header', 'Current invoice record');
        let lastLine = 0, lastId = '00000000-0000-0000-0000-000000000000';
        while (true) {
          const lines = await this.tx(tenant, 'Read bounded current invoice line facts', async (client) => (await client.query(`SELECT id,line_number,description,quantity::text,unit_price::text,tax_rate::text,line_total::text,source_evidence FROM public.invoice_line_items
          WHERE invoice_id=$1 AND (line_number,id)>($2::integer,$3::uuid) AND (source_page_id=$4::uuid OR (source_page_id IS NULL AND
          COALESCE(source_evidence#>>'{description,evidence,page}',source_evidence#>>'{quantity,evidence,page}',source_evidence#>>'{unit_price,evidence,page}',source_evidence#>>'{line_total,evidence,page}',source_evidence->>'page',$5::text)=$6::text))
          ORDER BY line_number,id LIMIT 100`, [invoice.id, lastLine, lastId, page.id, String(invoice.data.source_pages[0]), String(pageNumber)])).rows);
          if (!lines.length)
            break;
          for (const line of lines) {
            lastLine = line.line_number;
            lastId = line.id;
            const source = line.source_evidence;
            push('invoice-line:' + line.id, `Current line ${line.line_number} | Description ${line.description ?? 'unknown'} | Quantity ${line.quantity ?? 'unknown'} | Unit price ${line.unit_price ?? 'unknown'} | Tax rate ${line.tax_rate ?? 'unknown'} | Line total ${line.line_total ?? 'unknown'}`, invoice.id, source.description?.evidence?.cell ?? source.cell ?? null, 'table_row', 'Current invoice line items');
            if (units.length >= 40) {
              yield units;
              units = [];
            }
          }
        }
      }
      if (['pdf_page', 'image_frame'].includes(page.source_kind)) {
        for (const [index, line] of (page.extracted_text ?? '').split('\n').entries())
          push('page:' + page.id + ':' + index, line, invoices.length === 1 ? invoices[0].id : null, null, /description.*(?:qty|quantity|price)/i.test(line) || /^(?:(?:tax\s+)?invoice|receipt|চালান)$/iu.test(line.trim()) ? 'header' : 'text');
        while (units.length) {
          yield units.splice(0, 40);
        }
      }
      else {
        let blockNumber = 0, rowNumber: number | null = null, row: any[] = [];
        const headers = new Map<number, string>();
        const flush = () => {
          if (!row.length)
            return;
          const owner = invoices.find(invoice => invoice.data.source_locations.some((location: any) => location.page_number === pageNumber && rowNumber! >= location.row_start && rowNumber! <= location.row_end));
          const text = row.map(cell => `${headers.get(cell.column) ?? cell.reference}: ${cell.value}`).join(' | ');
          push('row:' + page.id + ':' + rowNumber, text, owner?.id ?? null, row[0].reference + ':' + row.at(-1).reference, 'table_row');
          row = [];
        };
        while (true) {
          const cells = await this.tx(tenant, 'Stream worksheet rows for indexing', async (client) => (await client.query("SELECT block_number,source_reference->'cell' AS cell FROM public.document_blocks WHERE page_id=$1 AND block_type='cell' AND block_number>$2 ORDER BY block_number LIMIT 200", [page.id, blockNumber])).rows);
          if (!cells.length)
            break;
          for (const block of cells) {
            blockNumber = block.block_number;
            const cell = block.cell;
            if (!cell)
              continue;
            const value = cell.value ?? cell.cached_value;
            if (value === null || value === undefined)
              continue;
            if (rowNumber !== null && rowNumber !== cell.row) {
              flush();
              if (units.length >= 40) {
                yield units;
                units = [];
              }
            }
            rowNumber = cell.row;
            if (cell.row === 1)
              headers.set(cell.column, String(value));
            row.push({ ...cell, value });
          }
        }
        flush();
        if (units.length)
          yield units;
      }
    }
  }
}
export function reciprocalRankFusion(keyword: SearchResult['items'], semantic: SearchResult['items'], limit: number) {
  const map = new Map<string, SearchResult['items'][number]>();
  for (const [kind, rows] of [['keyword', keyword], ['semantic', semantic]] as const)
    for (const [index, row] of rows.entries()) {
      const item = map.get(row.id) ?? { ...row, score: 0, keyword_rank: null, semantic_rank: null };
      item.score += 1 / (60 + index + 1);
      if (kind === 'keyword')
        item.keyword_rank = index + 1;
      else
        item.semantic_rank = index + 1;
      map.set(row.id, item);
    }
  return [...map.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
export async function searchDocuments(database: pg.Pool, context: TenantContext, space: EmbeddingSpace, input: SearchQuery, vector: number[] | null): Promise<SearchResult> {
  return withTenantTransaction(database, context, async (client) => {
    const filters = [input.invoice_number ?? null, input.supplier ?? null, input.date_from ?? null, input.date_to ?? null];
    const extra=[input.currency??null,input.amount_min??null,input.amount_max??null],fieldOnly=['exact','filter'].includes(input.mode),offset=fieldOnly?7:11;
    const invoiceFilter = `($1::text IS NULL OR i.invoice_number=$1) AND ($2::text IS NULL OR public.finance_identity(i.supplier_name)=public.finance_identity($2)) AND ($3::date IS NULL OR i.invoice_date>=$3::date) AND ($4::date IS NULL OR i.invoice_date<=$4::date) AND ($${offset}::text IS NULL OR i.currency=$${offset}) AND ($${offset+1}::numeric IS NULL OR i.total>=$${offset+1}::numeric) AND ($${offset+2}::numeric IS NULL OR i.total<=$${offset+2}::numeric)`;
    const currentInvoice = `(i.source_candidate_id IS NULL OR (c.understanding_run_id::text=d.metadata#>>'{understanding,runId}' AND NOT EXISTS(SELECT 1 FROM public.invoices n WHERE n.tenant_id=i.tenant_id AND n.source_candidate_id=i.source_candidate_id AND (n.created_at,n.id)>(i.created_at,i.id))))`;
    if (fieldOnly) {
      const rows = (await client.query(`SELECT i.id,i.source_document_id AS document_id,i.id AS invoice_id,COALESCE(i.invoice_number,'Unknown invoice') AS text,i.field_evidence AS source_reference FROM public.invoices i
        JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id) LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id)
        WHERE i.tenant_id=$5 AND NOT (d.metadata ? 'deleted') AND ${invoiceFilter} AND ${currentInvoice} ORDER BY i.invoice_date DESC NULLS LAST,i.id LIMIT $6`, [...filters, context.tenantId, input.limit,...extra])).rows;
      return searchResultSchema.parse({ mode: input.mode, space_id: null, items: rows.map(row => ({ ...row, kind: 'invoice', score: 1, keyword_rank: null, semantic_rank: null })) });
    }
    const base = `FROM public.document_chunks ch JOIN public.documents d ON (d.tenant_id,d.id)=(ch.tenant_id,ch.document_id)
      JOIN public.indexing_runs r ON (r.tenant_id,r.id)=(ch.tenant_id,ch.indexing_run_id)
      WHERE ch.tenant_id=$5 AND NOT (d.metadata ? 'deleted') AND r.status='succeeded' AND r.source_generation=d.search_generation AND d.metadata#>>'{search,runId}'=r.id::text
      AND r.space_id=$6 AND ch.embedding_model_id=$7 AND ch.embedding_model_version=$8 AND ch.embedding_configuration->>'space_id'=$6
      AND d.processing_status IN ('processed','needs_review','partially_processed') AND (ch.invoice_id IS NULL OR EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=ch.invoice_id AND i.review_status<>'rejected'))
      AND (($1::text IS NULL AND $2::text IS NULL AND $3::date IS NULL AND $4::date IS NULL AND $11::text IS NULL AND $12::numeric IS NULL AND $13::numeric IS NULL) OR EXISTS(SELECT 1 FROM public.invoices i LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id) WHERE i.source_document_id=d.id AND (ch.invoice_id IS NULL OR i.id=ch.invoice_id) AND ${invoiceFilter} AND ${currentInvoice}))`;
    const parameters = [...filters, context.tenantId, space.space_id, space.model_id, space.model_version];
    const select = 'SELECT ch.id,ch.document_id,ch.invoice_id,ch.chunk_text AS text,ch.source_reference ';
    let keyword: SearchResult['items'] = [], semantic: SearchResult['items'] = [];
    const size = Math.min(500, Math.max(100, input.limit * 5));
    if (['keyword', 'hybrid'].includes(input.mode)) {
      const rows = (await client.query(select + `,ts_rank_cd(ch.search_vector,websearch_to_tsquery('simple',$9)) AS score ` + base + ` AND ch.search_vector@@websearch_to_tsquery('simple',$9) ORDER BY score DESC,ch.id LIMIT $10`, [...parameters, input.q, size,...extra])).rows;
      keyword = rows.map((row, index) => ({ ...row, score: Number(row.score), kind: 'chunk', keyword_rank: index + 1, semantic_rank: null }));
    }
    if (['semantic', 'hybrid'].includes(input.mode)) {
      if (!vector || !validEmbedding(vector))
        throw new ServiceError('INVALID_QUERY_VECTOR', 502, 'Semantic query vector unavailable.');
      await client.query("SET LOCAL hnsw.iterative_scan='strict_order'");
      const rows = (await client.query(select + `,1-(ch.embedding <=> $9::vector) AS score ` + base + ` AND ch.embedding IS NOT NULL ORDER BY ch.embedding <=> $9::vector LIMIT $10`, [...parameters, JSON.stringify(vector), size,...extra])).rows;
      semantic = rows.map((row, index) => ({ ...row, score: Number(row.score), kind: 'chunk', keyword_rank: null, semantic_rank: index + 1 }));
    }
    return searchResultSchema.parse({ mode: input.mode, space_id: space.space_id, items: input.mode === 'hybrid' ? reciprocalRankFusion(keyword, semantic, input.limit) : (input.mode === 'keyword' ? keyword : semantic).slice(0, input.limit) });
  });
}
