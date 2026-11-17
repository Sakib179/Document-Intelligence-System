import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { RuntimeEnvironment, EmbeddingClient } from '@doc/core';
import { withTenantTransaction, WorkflowRepository } from '@doc/database';
import { buildApi } from '../fixtures/workspace-api.js';
import { buildWorker } from '../../apps/worker/src/app.js';
import { mockProvider } from '../fixtures/extraction.js';
import { ProviderFailure } from '../../apps/worker/src/extraction/types.js';
type Resources = {
  environment: RuntimeEnvironment;
  database: pg.Pool;
  fixtures: string;
  worker: ReturnType<typeof buildWorker>;
  workspace: string;
  otherWorkspace: string;
  readerWorkspace: string;
  query: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
  waitFor: (predicate: () => Promise<boolean>, timeout?: number) => Promise<void>;
};
export function registerWorkflowTests(resources: () => Resources) {
  describe('complete backend workflow and canonical API', { concurrency: false }, () => {
    let r: Resources, api: ReturnType<typeof buildApi>, worker: ReturnType<typeof buildWorker>, env: RuntimeEnvironment, primary: string, invoice: string;
    let failEmbedding = false, failExtraction = false;
    const client: EmbeddingClient = {
      async chunks(_tenant, _doc, units) { return units.map(unit => ({ chunk_text: unit.text, token_count: 50, invoice_id: unit.invoice_id, page_number: unit.page_number, worksheet: unit.worksheet, section: unit.section, source_references: [{ page_number: unit.page_number, cell_range: unit.cell_range }] })); },
      async embed(_tenant, texts) {
        if (failEmbedding)
          throw new Error('Controlled embedding outage');
        return texts.map(() => [1, ...Array(1023).fill(0)]);
      },
    };
    const call = async (url: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: Record<string, unknown>, bearer?: string) => api.inject({ url: '/api/v1' + url, method, headers: { 'x-test-workspace':  (bearer ?? r.workspace) }, ...(payload !== undefined ? { payload } : {}) });
    async function upload() {
      const boundary = 'workflow-' + randomUUID(), data = await readFile(join(r.fixtures, 'ai-invoice.pdf'));
      const response = await api.inject({ method: 'POST', url: '/api/v1/documents', headers: { 'x-test-workspace':  r.workspace, 'content-type': 'multipart/form-data; boundary=' + boundary, 'idempotency-key': randomUUID() }, payload: Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n'), data, Buffer.from('\r\n--' + boundary + '--\r\n')]) });
      assert.equal(response.statusCode, 202, response.body);
      assert.match(String(response.headers.location), /^\/api\/v1\//);
      return response.json().documents[0].id as string;
    }
    async function indexed(id: string) { await r.waitFor(async () => !!(await r.query("SELECT id FROM public.documents WHERE id=$1 AND metadata#>>'{search,generation}'=search_generation::text", [id])).rowCount); }
    async function failedJob(type: string, id: string) { await r.waitFor(async () => !!(await r.query("SELECT id FROM public.processing_jobs WHERE document_id=$1 AND job_type=$2 AND status='failed' ORDER BY created_at DESC LIMIT 1", [id, type])).rowCount); return (await r.query("SELECT * FROM public.processing_jobs WHERE document_id=$1 AND job_type=$2 AND status='failed' ORDER BY created_at DESC LIMIT 1", [id, type])).rows[0]; }
    before(async () => {
      r = resources();
      await r.worker.app.close();
      env = { ...r.environment, WORKFLOW_ENABLED: true, LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_LLM_MODEL: 'qwen-fixture-instruct', LLM_MAX_ATTEMPTS: 1, LLM_RETRY_BASE_MS: 10, LLM_RETRY_MAX_MS: 100 };
      const local = mockProvider('local_qwen'), original = local.extract;
      local.extract = async (...args) => {
        if (failExtraction)
          throw new ProviderFailure('PROVIDER_UNAVAILABLE');
        return original(...args);
      };
      api = buildApi(env, { embeddingClient: client });
      await api.ready();
      worker = buildWorker(env, { embeddingClient: client, extractionProviders: { gemini: null, local }, extractionWait: async () => { } });
      await worker.app.ready();
    });
    after(async () => { await worker?.app.close(); await api?.close(); });
    it('automatically runs upload, normalization, segmentation, extraction, financial validation and indexing', async () => {
      primary = await upload();
      await indexed(primary);
      const response = await call('/documents/' + primary + '/result');
      assert.equal(response.statusCode, 200, response.body);
      const record = response.json().invoices[0];
      assert.equal(record.invoice_number, 'INV-101');
      assert.equal(record.total, '115.00000000');
      assert.ok(record.evidence.total);
      invoice = record.id;
      assert.ok((await r.query('SELECT id FROM public.financial_validation_runs WHERE invoice_id=$1', [invoice])).rowCount);
      assert.ok((await call('/search?mode=hybrid&q=Widget')).json().items.some((item: any) => item.document_id === primary));
    });
    it('serves document detail and paginated lists under canonical and legacy paths', async () => {
      const list = await call('/documents?limit=1');
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json().documents.length, 1);
      assert.ok(list.json().nextCursor);
      assert.equal((await call('/documents?limit=1&cursor=' + list.json().nextCursor)).statusCode, 200);
      assert.equal((await call('/documents/' + primary)).json().document.id, primary);
      assert.equal((await api.inject({ url: '/v1/documents/' + primary, headers: { 'x-test-workspace':  r.workspace } })).statusCode, 200);
    });
    it('supports polling with persisted progress, stage counts and bounded cursor pages', async () => {
      const response = await call('/documents/' + primary + '/status?limit=1');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['retry-after'], '2');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.json().jobs.items.length, 1);
      assert.ok(response.json().jobs.next_cursor);
      assert.ok(response.json().job_counts.length);
      assert.equal((await call('/documents/' + primary + '/status?cursor=' + response.json().jobs.next_cursor)).statusCode, 200);
    });
    it('returns bounded current results, line evidence and an empty page after the result cursor', async () => {
      const response = await call('/documents/' + primary + '/result?limit=1');
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().processing.manifestKey);
      assert.equal(response.json().invoices[0].line_items.length, 1);
      assert.equal((await call('/documents/' + primary + '/result?cursor=bad')).statusCode, 400);
    });
    it('records actor, timestamp, reason and originals and atomically schedules revalidation and reindexing', async () => {
      const before = (await call('/documents/' + primary + '/result')).json().invoices[0];
      const terms = await call('/invoices/' + invoice + '/financial-terms', 'PATCH', { revision: before.revision, reason: 'Synthetic explicit tax convention', terms: { tax_mode: 'exclusive', subtotal_basis: 'net', line_amount_basis: 'net', charges: '0', discounts: '0', withholding: '0', adjustments_complete: true, line_items_complete: true } });
      assert.equal(terms.statusCode, 200, terms.body);
      await indexed(primary);
      const first = (await call('/documents/' + primary + '/result')).json().invoices[0];
      const response = await call('/invoices/' + invoice, 'PATCH', { revision: first.revision, changes: { total: '120.00' }, reason: 'Checked the scanned total' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().invoice.original_values.total, '115.00000000');
      assert.equal(response.json().invoice.total, '120.00000000');
      assert.ok(response.json().workflow_job.id);
      await indexed(primary);
      await r.waitFor(async () => (await call('/invoices/' + invoice + '/validations')).json().runs[0]?.is_current === true);
      const report = (await call('/invoices/' + invoice + '/validations')).json();
      assert.ok(report.runs[0].result.issues.some((issue: any) => issue.code === 'TOTAL_MISMATCH'));
      assert.equal(report.runs[0].snapshot.invoice.total, '120.00000000');
      const history = await call('/invoices/' + invoice + '/history');
      assert.equal(history.statusCode, 200, history.body);
      const correction = history.json().items.find((item: any) => item.reason === 'Checked the scanned total');
      assert.equal(correction.actor_user_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      assert.ok(correction.created_at);
      assert.ok(correction.before_json.includes('115'));
      assert.ok(correction.after_json.includes('120'));
      assert.ok((await call('/search?mode=keyword&q=120.00000000')).json().items.some((item: any) => item.document_id === primary));
    });
    it('accepts an omitted reason with an explicit audit marker and rejects stale revisions', async () => {
      const record = (await call('/documents/' + primary + '/result')).json().invoices[0], body = { revision: record.revision, changes: { customer_name: 'Reviewed Buyer' } };
      assert.equal((await call('/invoices/' + invoice, 'PATCH', body)).statusCode, 200);
      assert.equal((await call('/invoices/' + invoice, 'PATCH', body)).statusCode, 409);
      await indexed(primary);
      assert.ok((await call('/invoices/' + invoice + '/history')).json().items.some((item: any) => item.reason === 'Manual correction (no reason supplied)'));
    });
    it('paginates the review queue without crossing tenant boundaries', async () => {
      const first = await call('/reviews?limit=1');
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().items.length, 1);
      assert.ok(first.json().next_cursor);
      const next = await call('/reviews?limit=1&cursor=' + first.json().next_cursor);
      assert.notEqual(first.json().items[0].id, next.json().items[0].id);
      assert.ok(!(await call('/reviews', 'GET', undefined, r.otherWorkspace)).json().items.some((item: any) => item.document_id === primary));
    });
    it('corrects line items atomically, preserves their originals and audits changes', async () => {
      const current = (await call('/documents/' + primary + '/result')).json().invoices[0], line = current.line_items[0];
      const response = await call('/invoices/' + invoice, 'PATCH', { revision: current.revision, line_items: [{ id: line.id, revision: line.revision, changes: { unit_price: '60.00' } }], reason: 'Reviewed line price' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().invoice.line_items[0].unit_price, '60.00000000');
      assert.equal(response.json().invoice.line_items[0].original_values.unit_price, '50.00000000');
      await indexed(primary);
      const history = (await call('/invoices/' + invoice + '/history')).json();
      assert.ok(history.items.some((event: any) => event.entity_table === 'invoice_line_items' && event.reason === 'Reviewed line price'));
      const changed = response.json().invoice;
      assert.equal((await call('/invoices/' + invoice, 'PATCH', { revision: changed.revision, changes: { customer_name: 'Must roll back' }, line_items: [{ id: line.id, revision: line.revision, changes: { unit_price: '70.00' } }] })).statusCode, 409);
      assert.equal((await call('/documents/' + primary + '/result')).json().invoices[0].customer_name, changed.customer_name);
    });
    it('returns reconciliation results and refreshes existing comparisons after correction', async () => {
      const second = await upload();
      await indexed(second);
      const initial = await call('/reconciliations', 'POST', { left_document_id: primary, right_document_id: second });
      assert.equal(initial.statusCode, 201, initial.body);
      const id = initial.json().run.id;
      assert.equal((await call('/reconciliations/' + id)).statusCode, 200);
      assert.equal((await call('/reconciliations/' + id, 'GET', undefined, r.otherWorkspace)).statusCode, 404);
      const record = (await call('/documents/' + primary + '/result')).json().invoices[0];
      await call('/invoices/' + invoice, 'PATCH', { revision: record.revision, changes: { total: '115.00' } });
      await r.waitFor(async () => (await r.query('SELECT id FROM public.reconciliation_runs WHERE left_document_id=$1 AND right_document_id=$2', [primary, second])).rowCount! > 1);
      assert.equal((await call('/reconciliations/' + id)).json().is_current, false);
      await indexed(primary);
    });
    it('retains failed extraction history and recovers through the retry endpoint', async () => {
      failExtraction = true;
      const id = await upload(), failed = await failedJob('extract', id);
      failExtraction = false;
      const response = await call('/jobs/' + failed.id + '/retry', 'POST', {});
      assert.equal(response.statusCode, 202, response.body);
      await indexed(id);
      await r.waitFor(async () => !!(await r.query("SELECT id FROM public.processing_jobs WHERE document_id=$1 AND job_type='extract' AND status='succeeded'", [id])).rowCount);
      assert.equal((await r.query('SELECT status FROM public.processing_jobs WHERE id=$1', [failed.id])).rows[0].status, 'failed');
    });
    it('persists terminal indexing failure and retries with a new compatible index run', async () => {
      failEmbedding = true;
      const id = await upload();
      // Avoid a same-tenant vector-cache hit for this controlled failure.
      await r.waitFor(async () => !!(await r.query("SELECT id FROM public.invoices WHERE source_document_id=$1", [id])).rowCount);
      const record = (await call('/documents/' + id + '/result')).json().invoices[0];
      await call('/invoices/' + record.id, 'PATCH', { revision: record.revision, changes: { customer_name: 'Unique index outage ' + randomUUID() } });
      const failed = await failedJob('index', id);
      failEmbedding = false;
      assert.equal((await call('/jobs/' + failed.id + '/retry', 'POST', {})).statusCode, 202);
      await indexed(id);
      assert.equal((await r.query('SELECT status FROM public.processing_jobs WHERE id=$1', [failed.id])).rows[0].status, 'failed');
    });
    it('uses idempotent recovery requests, preserves failed jobs and rejects successful-job retry', async () => {
      const id = randomUUID();
      await r.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,status,last_error_code,finished_at) VALUES($1,'11111111-1111-4111-8111-111111111111',$2,'workflow','workflow-v1',$1::uuid::text,'failed','CONTROLLED_TEST',clock_timestamp())", [id, primary]);
      const request = { url: '/api/v1/jobs/' + id + '/retry', method: 'POST' as const, headers: { 'x-test-workspace':  r.workspace, 'idempotency-key': 'recover-stable-key' }, payload: { reason: 'Recovered local dependency' } };
      const [a, b] = await Promise.all([api.inject(request), api.inject(request)]);
      assert.equal(a.statusCode, 202, a.body);
      assert.equal(a.json().job_id, b.json().job_id);
      await r.waitFor(async () => (await r.query('SELECT status FROM public.processing_jobs WHERE id=$1', [a.json().job_id])).rows[0].status === 'succeeded');
      assert.equal((await api.inject(request)).json().job_id, a.json().job_id);
      assert.equal((await call('/jobs/' + a.json().job_id + '/retry', 'POST', {})).statusCode, 409);
    });
    it('retries failed ingestion with a new stable job without rewriting the original', async () => {
      const original = (await r.query("SELECT * FROM public.processing_jobs WHERE document_id=$1 AND job_type='ingest' AND status='succeeded' LIMIT 1", [primary])).rows[0], id = randomUUID();
      await r.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,payload,dispatch_state,status,finished_at) VALUES($1,$2,$3,'ingest','document-v1',$1::uuid::text,'document-queue',$1::uuid::text,$4,'dead','failed',clock_timestamp())", [id, original.tenant_id, primary, JSON.stringify({ ...original.payload, jobId: id })]);
      const request = { url: '/api/v1/jobs/' + id + '/retry', method: 'POST' as const, headers: { 'x-test-workspace':  r.workspace, 'idempotency-key': 'replay-ingestion-recovery' }, payload: {} };
      const response = await api.inject(request);
      assert.equal(response.statusCode, 202, response.body);
      await r.waitFor(async () => !!(await r.query("SELECT id FROM public.processing_jobs WHERE parent_job_id=$1 AND job_type='ingest' AND status='succeeded'", [id])).rowCount);
      await indexed(primary);
      assert.equal((await r.query('SELECT status FROM public.processing_jobs WHERE id=$1', [id])).rows[0].status, 'failed');
      assert.equal((await api.inject(request)).json().job_id, response.json().job_id);
    });
    it('recovers an expired workflow execution lease after an interrupted worker', async () => {
      const id = randomUUID();
      await r.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,status,attempts,execution_lease_token,execution_lease_until,payload) VALUES($1,'11111111-1111-4111-8111-111111111111',$2,'workflow','workflow-v1',$1::uuid::text,'running',1,$3,clock_timestamp()-interval '1 second','{\"kind\":\"refresh\"}')", [id, primary, randomUUID()]);
      await r.waitFor(async () => (await r.query('SELECT status FROM public.processing_jobs WHERE id=$1', [id])).rows[0].status === 'succeeded');
      assert.equal((await r.query('SELECT attempts FROM public.processing_jobs WHERE id=$1', [id])).rows[0].attempts, 2);
    });
    it('reports missing extraction configuration instead of claiming recovery succeeded', async () => {
      const old = (await r.query("SELECT * FROM public.processing_jobs WHERE job_type='extract' AND status='failed' ORDER BY created_at DESC LIMIT 1")).rows[0];
      await assert.rejects(new WorkflowRepository(r.database, { ...env, LOCAL_LLM_BASE_URL: '', CLOUD_LLM_ENABLED: false }).execute({ id: randomUUID(), tenant_id: old.tenant_id, document_id: old.document_id, parent_job_id: old.id, payload: { kind: 'retry' } }), { code: 'EXTRACTION_NOT_CONFIGURED' });
    });
    it('accepts direct workspace access without sign-in', async () => {
      for (const [method, url] of [['POST', '/documents'], ['GET', '/documents'], ['GET', '/documents/' + primary], ['GET', '/documents/' + primary + '/status'], ['GET', '/documents/' + primary + '/result'], ['GET', '/search?q=paper'], ['PATCH', '/invoices/' + invoice], ['GET', '/reviews'], ['POST', '/jobs/' + randomUUID() + '/retry'], ['GET', '/reconciliations/' + randomUUID()]] as const) {
        const response = await api.inject({ url: '/api/v1' + url, method });
        assert.notEqual(response.statusCode, 401, method + ' ' + url + ' ' + response.body);
      }
    });
    it('enforces tenant access, reviewer permissions and strict input validation', async () => {
      for (const suffix of ['', '/status', '/result'])
        assert.equal((await call('/documents/' + primary + suffix, 'GET', undefined, r.otherWorkspace)).statusCode, 404);
      assert.equal((await call('/invoices/' + invoice, 'PATCH', { revision: 1, changes: { total: '1' } }, r.otherWorkspace)).statusCode, 404);
      assert.equal((await call('/invoices/' + invoice, 'PATCH', { revision: 1, changes: { total: '1' } }, r.readerWorkspace)).statusCode, 403);
      assert.equal((await call('/jobs/' + randomUUID() + '/retry', 'POST', {}, r.readerWorkspace)).statusCode, 403);
      assert.equal((await call('/search?mode=exact&invoice_number=INV-101', 'GET', undefined, r.otherWorkspace)).json().items.length, 0);
      for (const changes of [{ total: 0.1 }, { total: 'NaN' }, { currency: 'dollars' }, { invoice_date: '2026-02-30' }, { tenant_id: randomUUID() }, {}])
        assert.equal((await call('/invoices/' + invoice, 'PATCH', { revision: 1, changes })).statusCode, 400);
      for (const url of ['/reviews?limit=101', '/reviews?cursor=bad', '/documents/not-a-uuid', '/documents/' + primary + '/status?unexpected=1', '/search?mode=semantic'])
        assert.equal((await call(url)).statusCode, 400, url);
      const response = await api.inject({ url: '/api/v1/invoices/' + invoice, method: 'PATCH', headers: { 'x-test-workspace':  r.workspace, 'content-type': 'application/json' }, payload: '{invalid' });
      assert.equal(response.statusCode, 400, response.body);
    });
    it('publishes valid OpenAPI with every required endpoint without bearer authentication', async () => {
      const response = await api.inject('/api/openapi.json');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().openapi, '3.1.0');
      for (const path of ['/documents', '/documents/{id}', '/documents/{id}/status', '/documents/{id}/result', '/search', '/invoices/{id}', '/reviews', '/jobs/{id}/retry', '/reconciliations/{id}'])
        assert.ok(response.json().paths['/api/v1' + path], path);
      assert.equal(response.json().components.securitySchemes, undefined);
    });
    it('limits workflow discovery to the restricted dispatcher and preserves tenant scope', async () => {
      await assert.rejects(r.database.query('SELECT * FROM public.claim_workflow_job()'), { code: '42501' });
      const service = new WorkflowRepository(r.database, env);
      await assert.rejects(service.result({ tenantId: '22222222-2222-4222-8222-222222222222' }, primary, { limit: 1 }), /Document not found/);
    });
  });
}
