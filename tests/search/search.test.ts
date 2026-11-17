import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvironment, createRedis, ServiceError } from '@doc/core';
import type { EmbeddingClient } from '@doc/core';
import { createDatabasePool, withTenantTransaction, IndexRepository } from '@doc/database';
import { createMigrationPool, createDispatcherPool, runMigrations, provisionApplicationRole, provisionDispatcherRole, seedDevelopmentDatabase, migrationStatus } from '@doc/database/admin';
import { HARRIER_EMBEDDING_ID, HARRIER_EMBEDDING_VERSION } from '@doc/contracts';
import { buildApi } from '../fixtures/workspace-api.js';
import { buildWorker } from '../../apps/worker/src/app.js';
import { selectWorkspace } from '../fixtures/workspace-api.js';
import { IngestionOutbox } from '../../apps/worker/src/outbox.js';
const root = {...loadEnvironment(),WORKFLOW_ENABLED:false}, suffix = randomUUID().replaceAll('-', ''), name = 'di_search_test_' + suffix;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', UA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', UB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', READER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const context = { tenantId: A, actorUserId: UA, reason: 'Explicit synthetic search fixture' };
const env = { ...root, POSTGRES_DB: name, QUEUE_PREFIX: 'di-search-' + suffix, LOG_LEVEL: 'silent' as const, OUTBOX_POLL_MS: 100, OUTBOX_RECHECK_SECONDS: 1, INGESTION_BACKOFF_MS: 100, CLOUD_LLM_ENABLED: false, SEGMENTATION_AI_ENABLED: false, EXTRACTION_AUTO_START: false };
const cluster = createMigrationPool(root);
let database: ReturnType<typeof createDatabasePool>, admin: ReturnType<typeof createMigrationPool>, dispatcher: ReturnType<typeof createDispatcherPool>, api: ReturnType<typeof buildApi>, worker: ReturnType<typeof buildWorker>, workspace: string, otherWorkspace: string, readerWorkspace: string, created = false;
let mode: 'ok' | 'once' | 'fail' | 'invalid' = 'ok', documentCalls = 0, onEmbed: (() => Promise<void>) | null = null;
const vectors = (text: string) => { const vector = Array(1024).fill(0); vector[/solar|সৌর/.test(text) ? 1 : /paper|pens|কাগজ|কলম/.test(text) ? 0 : 2] = 1; return vector; };
const embeddingClient: EmbeddingClient = {
  async chunks(_tenant, _document, units) { return units.map(unit => ({ chunk_text: unit.text, invoice_id: unit.invoice_id, page_number: unit.page_number, worksheet: unit.worksheet, section: unit.section, token_count: Math.max(1, Math.ceil(unit.text.length / 4)), source_references: [{ unit_id: unit.unit_id, page_number: unit.page_number, worksheet: unit.worksheet, cell_range: unit.cell_range }] })); },
  async embed(_tenant, texts, kind) {
    if (kind === 'document') {
      documentCalls++;
      if (onEmbed) {
        const action = onEmbed;
        onEmbed = null;
        await action();
      }
      if (mode === 'once') {
        mode = 'ok';
        throw new ServiceError('EMBEDDER_UNAVAILABLE', 503, 'Controlled retry');
      }
      if (mode === 'fail')
        throw new ServiceError('EMBEDDER_UNAVAILABLE', 503, 'Controlled outage');
    }
    return texts.map(text => mode === 'invalid' ? Array(1024).fill(0) : vectors(text));
  }
};
const query = (sql: string, values: unknown[] = []) => withTenantTransaction(database, context, client => client.query(sql, values));
async function waitFor(action: () => Promise<boolean>) {
  const until = Date.now() + 20000; while (Date.now() < until) {
    if (await action())
      return;
    await delay(50);
  } throw new Error('Search state wait exceeded');
}
async function documentFixture(options: {
  tenant?: string;
  user?: string;
  number?: string;
  text?: string;
  worksheet?: boolean;
} = {}) {
  const tenant = options.tenant ?? A, user = options.user ?? UA, id = randomUUID(), jobId = randomUUID(), runId = randomUUID(), candidate = randomUUID(), pageId = randomUUID(), invoice = randomUUID();
  await withTenantTransaction(database, { tenantId: tenant, actorUserId: user, reason: 'Synthetic normalized search source' }, async (client) => {
    await client.query("INSERT INTO public.documents(id,tenant_id,original_filename,mime_type,file_size_bytes,sha256,object_storage_key,processing_status,page_count,metadata) VALUES($1,$2,'synthetic-search-source',$3,100,$4,$5,'processed',1,$6)", [id, tenant, options.worksheet ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf', createHash('sha256').update(id).digest('hex'), 'development-fixture/not-uploaded/' + id, JSON.stringify({ development_fixture: true, processing: { sourceVersion: 1 }, understanding: { runId } })]);
    await client.query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key) VALUES($1,$2,$3,'search_fixture','not-executed',$1::uuid::text)", [jobId, tenant, id]);
    await client.query("INSERT INTO public.document_understanding_runs(id,tenant_id,document_id,processing_job_id,source_version,manifest_key,algorithm_version,document_type,segmentation_confidence,requires_manual_review,candidate_count,invoice_candidate_count,ai_status) VALUES($1,$2,$3,$4,1,'fixture-not-executed','segmentation-v1','invoice',1,false,1,1,'disabled')", [runId, tenant, id, jobId]);
    const data = { candidate_id: candidate, document_id: id, document_type: 'invoice', source_pages: [1], source_worksheets: options.worksheet ? ['Ledger'] : [], source_locations: [{ page_number: 1, row_start: 2, row_end: 2, table_header_row: 1 }], requires_manual_review: false, segmentation_confidence: 1 };
    await client.query("INSERT INTO public.invoice_candidates(id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) VALUES($1,$2,$3,$4,1,'invoice',1,false,$5)", [candidate, tenant, id, runId, JSON.stringify(data)]);
    await client.query("INSERT INTO public.document_pages(id,tenant_id,document_id,page_number,source_kind,extracted_text,extraction_method,worksheet_name) VALUES($1,$2,$3,1,$4,$5,$6,$7)", [pageId, tenant, id, options.worksheet ? 'worksheet' : 'pdf_page', options.text ?? 'Office paper and pens.\nকাগজ কলম অফিসের সরবরাহ।\nPage 1 of 1', options.worksheet ? 'spreadsheet' : 'digital', options.worksheet ? 'Ledger' : null]);
    await client.query("INSERT INTO public.invoices(id,tenant_id,source_document_id,source_candidate_id,invoice_number,supplier_name,invoice_date,currency,total,review_status) VALUES($1,$2,$3,$4,$5,'Padma Supplies','2026-10-03','BDT','115','needs_review')", [invoice, tenant, id, candidate, options.number ?? 'SEARCH-101']);
    await client.query("INSERT INTO public.invoice_line_items(tenant_id,invoice_id,source_document_id,line_number,description,quantity,unit_price,line_total) VALUES($1,$2,$3,1,'paper',2,50,100)", [tenant, invoice, id]);
    if (options.worksheet) {
      for (const [index, value] of ['Item', 'Amount', 'paper pens', '115'].entries()) {
        const row = index < 2 ? 1 : 2, column = index % 2 + 1, reference = (column === 1 ? 'A' : 'B') + row;
        await client.query("INSERT INTO public.document_blocks(tenant_id,document_id,page_id,block_number,block_type,extracted_text,source_reference) VALUES($1,$2,$3,$4,'cell',$5,$6)", [tenant, id, pageId, index + 1, value, JSON.stringify({ cell: { row, column, reference, value, cached_value: null, formula: null } })]);
      }
    }
  });
  return { id, invoice };
}
async function index(id: string, force = false, key = randomUUID()) {
  const response = await api.inject({ method: 'POST', url: `/v1/documents/${id}/index`, headers: { 'x-test-workspace':  workspace, 'idempotency-key': key }, payload: { reindex: force } });
  assert.equal(response.statusCode, 202, response.body);
  return response.json();
}
async function done(run: string) { await waitFor(async () => !!(await query("SELECT id FROM public.indexing_runs WHERE id=$1 AND status IN ('succeeded','failed','cancelled')", [run])).rowCount); return (await query('SELECT * FROM public.indexing_runs WHERE id=$1', [run])).rows[0]; }
async function search(parameters: Record<string, string>, bearer = workspace, instance = api) { return instance.inject({ url: '/v1/search?' + new URLSearchParams(parameters), headers: { 'x-test-workspace':  bearer } }); }
let primary: {
  id: string;
  invoice: string;
};
describe('durable local indexing and tenant-scoped PostgreSQL search', { concurrency: false }, () => {
  before(async () => {
    await provisionApplicationRole(cluster, root.POSTGRES_APP_PASSWORD);
    await provisionDispatcherRole(cluster, root.POSTGRES_DISPATCHER_PASSWORD);
    await cluster.query('CREATE DATABASE "' + name + '" TEMPLATE template0');
    created = true;
    admin = createMigrationPool(env);
    database = createDatabasePool(env);
    dispatcher = createDispatcherPool(env);
    await runMigrations(admin);
    await seedDevelopmentDatabase(admin, 'test');
    await admin.query("INSERT INTO public.users(id,tenant_id,email,display_name,role) VALUES($1,$2,'search-reader@example.invalid','Reader','reader')", [READER, A]);
    api = buildApi(env, { embeddingClient });
    await api.ready();
    worker = buildWorker(env, { embeddingClient });
    await worker.app.ready();
    await worker.indexing.waitUntilReady();
    workspace = await selectWorkspace(env, { tenantId: A, userId: UA });
    otherWorkspace = await selectWorkspace(env, { tenantId: B, userId: UB });
    readerWorkspace = await selectWorkspace(env, { tenantId: A, userId: READER });
    primary = await documentFixture();
  });
  after(async () => {
    if (worker)
      await worker.app.close();
    if (api)
      await api.close();
    const redis = createRedis(env);
    try {
      await new Promise<void>((resolve, reject) => {
        if (redis.status === 'ready')
          resolve();
        else {
          redis.once('ready', resolve);
          redis.once('error', reject);
        }
      });
      let cursor = '0';
      do {
        const result = await redis.scan(cursor, 'MATCH', env.QUEUE_PREFIX + ':*', 'COUNT', 1000);
        cursor = result[0];
        if (result[1].length)
          await redis.del(...result[1]);
      } while (cursor !== '0');
    }
    finally {
      redis.disconnect();
    }
    if (database)
      await database.end();
    if (dispatcher)
      await dispatcher.end();
    if (admin)
      await admin.end();
    try {
      if (created)
        await cluster.query('DROP DATABASE "' + name + '" WITH (FORCE)');
    }
    finally {
      await cluster.end();
    }
  });
  it('indexes actual queue jobs into normalized 1024-dimensional vectors and versioned source references', async () => {
    const accepted = await index(primary.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    assert.ok(run.chunk_count > 0);
    const chunks = (await query('SELECT *,vector_dims(embedding) AS dimensions FROM public.document_chunks WHERE indexing_run_id=$1', [run.id])).rows;
    assert.ok(chunks.every(chunk => chunk.dimensions === 1024 && chunk.embedding_model_id === env.EMBEDDING_MODEL_ID && chunk.embedding_model_version === env.EMBEDDING_MODEL_VERSION));
    assert.equal(chunks[0].source_reference.page_number, 1);
    assert.equal(chunks[0].invoice_id, primary.invoice);
    const job = (await query('SELECT * FROM public.processing_jobs WHERE id=$1', [accepted.job_id])).rows[0];
    assert.equal(job.payload.documentId, primary.id);
    assert.equal(job.payload.text, undefined);
    assert.equal(job.queue_job_id, job.id);
    assert.equal(job.status, 'succeeded');
  });
  it('supports exact invoice SQL search and supplier/date filtering without embedding calls', async () => {
    const response = await search({ mode: 'exact', invoice_number: 'SEARCH-101', supplier: 'Padma Supplies', date_from: '2026-10-01', date_to: '2026-10-10' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items[0].invoice_id, primary.invoice);
    assert.deepEqual((await search({ mode: 'exact', invoice_number: 'SEARCH-101', date_from: '2026-11-01' })).json().items, []);
    assert.deepEqual((await search({ mode: 'exact', invoice_number: 'search-101' })).json().items, []);
  });
  it('provides FTS, semantic cosine and reciprocal-rank hybrid search', async () => {
    for (const mode of ['keyword', 'semantic', 'hybrid']) {
      const response = await search({ mode, q: 'paper', supplier: 'Padma Supplies' });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().items.some((item: any) => item.document_id === primary.id));
      if (mode === 'hybrid')
        assert.ok(response.json().items.some((item: any) => item.keyword_rank && item.semantic_rank));
    }
    const bangla = await search({ mode: 'keyword', q: 'কাগজ' });
    assert.equal(bangla.statusCode, 200, bangla.body);
    assert.ok(bangla.json().items.length > 0);
  });
  it('keeps same-key indexing stable and reuses tenant-scoped cached vectors on forced reindex', async () => {
    const original = await index(primary.id), replayed = await index(primary.id, false);
    assert.equal(original.run_id, replayed.run_id);
    const before = documentCalls, forced = await index(primary.id, true), run = await done(forced.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    assert.notEqual(forced.run_id, original.run_id);
    assert.equal(documentCalls, before);
    assert.equal(run.cache_hits, run.chunk_count);
    assert.equal((await query('SELECT id FROM public.indexing_runs WHERE document_id=$1 AND status=\'succeeded\'', [primary.id])).rowCount, 2);
  });
  it('preserves worksheet and cell anchors', async () => {
    const source = await documentFixture({ worksheet: true, number: 'SHEET-101' }), accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    const rows = (await query('SELECT source_reference FROM public.document_chunks WHERE indexing_run_id=$1', [run.id])).rows;
    assert.ok(rows.some(row => row.source_reference.worksheet === 'Ledger' && row.source_reference.sources.some((ref: any) => ref.cell_range === 'A2:B2')));
  });
  it('retains repeated uppercase item descriptions rather than mistaking them for boilerplate', async () => {
    const source = await documentFixture({ number: 'ITEMS-101', text: 'PAPER\n50\nPAPER\n70' }), accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    assert.equal((await query("SELECT id FROM public.document_chunks WHERE indexing_run_id=$1 AND chunk_text='PAPER'", [run.id])).rowCount, 2);
  });
  it('isolates every search path, index metadata and cache reads across tenants', async () => {
    for (const mode of ['exact', 'keyword', 'semantic', 'hybrid']) {
      const response = await search(mode === 'exact' ? { mode, invoice_number: 'SEARCH-101' } : { mode, q: 'paper' }, otherWorkspace);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().items, []);
    }
    assert.equal((await api.inject({ url: `/v1/documents/${primary.id}/index`, headers: { 'x-test-workspace':  otherWorkspace } })).statusCode, 404);
    assert.equal((await database.query('SELECT id FROM public.indexing_runs')).rowCount, 0);
    const foreign = new IndexRepository(database, env);
    assert.equal((await foreign.cached(B, ['Office paper and pens.'])).size, 0);
  });
  it('requires authorization, reader permissions, strict queries and valid input state', async () => {
    assert.equal((await api.inject('/v1/search?mode=keyword&q=paper')).statusCode, 200);
    assert.equal((await api.inject({ method: 'POST', url: `/v1/documents/${primary.id}/index`, headers: { 'x-test-workspace':  readerWorkspace }, payload: {} })).statusCode, 403);
    assert.equal((await search({ mode: 'semantic', q: '', sql: 'DROP TABLE documents' })).statusCode, 400);
    assert.equal((await search({ mode: 'keyword', q: 'paper', date_from: '2026-12-01', date_to: '2026-01-01' })).statusCode, 400);
    const seed = '20000000-0000-4000-8000-000000000001';
    assert.equal((await api.inject({ method: 'POST', url: `/v1/documents/${seed}/index`, headers: { 'x-test-workspace':  workspace }, payload: {} })).statusCode, 409);
  });
  it('invalidates stale chunks after corrections and exposes only a completed new generation', async () => {
    await query("UPDATE public.invoices SET supplier_name='Updated supplier' WHERE id=$1", [primary.invoice]);
    assert.ok(!(await search({ mode: 'keyword', q: 'paper' })).json().items.some((item: any) => item.document_id === primary.id));
    const updated = await index(primary.id), run = await done(updated.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    assert.ok((await search({ mode: 'keyword', q: 'paper', supplier: 'Updated supplier' })).json().items.some((item: any) => item.document_id === primary.id));
  });
  it('cancels publication if source facts change while a batch is embedding', async () => {
    const source = await documentFixture({ number: 'CONCURRENT-101', text: 'solar panels and storage batteries unique source' });
    onEmbed = () => query("UPDATE public.invoices SET supplier_name='Changed concurrently' WHERE id=$1", [source.invoice]).then(() => undefined);
    const accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'INDEX_SOURCE_CHANGED');
    assert.ok(!(await search({ mode: 'semantic', q: 'solar' })).json().items.some((item: any) => item.document_id === source.id));
  });
  it('indexes corrected customer and line-item facts separately from immutable document text', async () => {
    const source = await documentFixture({ number: 'CORRECTED-101' });
    await query("UPDATE public.invoices SET customer_name='Corrected scientific laboratory' WHERE id=$1", [source.invoice]);
    await query("UPDATE public.invoice_line_items SET description='Corrected microscopes' WHERE invoice_id=$1", [source.invoice]);
    const accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    const response = await search({ mode: 'keyword', q: 'microscopes' });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().items.some((item: any) => item.document_id === source.id && item.source_reference.section === 'Current invoice line items'));
    assert.ok((await search({ mode: 'keyword', q: 'laboratory' })).json().items.some((item: any) => item.document_id === source.id));
    assert.ok((await query("SELECT id FROM public.document_chunks WHERE indexing_run_id=$1 AND source_reference->>'section'='Document source'", [run.id])).rowCount! > 0);
  });
  it('bounds embedding retries, retains terminal failures and recovers with a new request key', async () => {
    mode = 'fail';
    const source = await documentFixture({ number: 'FAIL-101', text: 'unique unavailable embedding input' }), accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'failed');
    const job = (await query('SELECT attempts,status FROM public.processing_jobs WHERE id=$1', [accepted.job_id])).rows[0];
    assert.equal(job.attempts, 3);
    assert.equal(job.status, 'failed');
    mode = 'ok';
    const retried = await index(source.id), recovered = await done(retried.run_id);
    assert.equal(recovered.status, 'succeeded', recovered.error_code);
  });
  it('recovers transient embedding errors without leaving an error on a successful job', async () => {
    mode = 'once';
    const source = await documentFixture({ number: 'RETRY-101', text: 'unique transient retry content' }), accepted = await index(source.id), run = await done(accepted.run_id);
    assert.equal(run.status, 'succeeded', run.error_code);
    const job = (await query('SELECT attempts,last_error_code FROM public.processing_jobs WHERE id=$1', [accepted.job_id])).rows[0];
    assert.equal(job.attempts, 2);
    assert.equal(job.last_error_code, null);
  });
  it('never mixes equal-dimensional vectors from different model spaces', async () => {
    const alternate = buildApi({ ...env, EMBEDDING_MODEL_ID: HARRIER_EMBEDDING_ID, EMBEDDING_MODEL_VERSION: HARRIER_EMBEDDING_VERSION }, { embeddingClient });
    await alternate.ready();
    try {
      const response = await search({ mode: 'semantic', q: 'paper' }, workspace, alternate);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().items, []);
    }
    finally {
      await alternate.close();
    }
  });
  it('keeps indexed vectors and finalized run records immutable', async () => {
    const row = (await query('SELECT id,indexing_run_id FROM public.document_chunks WHERE indexing_run_id IS NOT NULL LIMIT 1')).rows[0];
    await assert.rejects(query("UPDATE public.document_chunks SET embedding_model_id='other' WHERE id=$1", [row.id]), { code: '23514' });
    await assert.rejects(query("UPDATE public.indexing_runs SET chunk_count=0 WHERE id=$1", [row.indexing_run_id]), { code: '23514' });
  });
  it('retains durable indexing intent while the queue is unavailable', async () => {
    await worker.dispatcher.stop();
    const source = await documentFixture({ number: 'QUEUE-101' }), accepted = await index(source.id);
    const queue = worker.queues.get('indexing-queue')!, originalAdd = queue.add.bind(queue);
    queue.add = async () => { throw new Error('Controlled queue failure'); };
    try {
      await worker.dispatcher.dispatchOnce();
    }
    finally {
      queue.add = originalAdd;
    }
    const retained = (await query('SELECT dispatch_state,dispatch_failures FROM public.processing_jobs WHERE id=$1', [accepted.job_id])).rows[0];
    assert.equal(retained.dispatch_state, 'retry_wait');
    assert.equal(retained.dispatch_failures, 1);
    await delay(300);
    worker.dispatcher.start();
    assert.equal((await done(accepted.run_id)).status, 'succeeded');
  });
  it('keeps completed jobs successful when a publish acknowledgement is lost', async () => {
    await worker.dispatcher.stop();
    try {
      const source = await documentFixture({ number: 'ACK-RACE-101', text: 'unique completed publishing acknowledgement race' }), accepted = await index(source.id);
      await query('UPDATE public.processing_jobs SET dispatch_max_failures=1 WHERE id=$1', [accepted.job_id]);
      const claims = await dispatcher.query('SELECT * FROM public.claim_indexing_dispatches(10,30)'), claim = claims.rows.find(row => row.job_id === accepted.job_id);
      assert.ok(claim);
      await worker.queues.get('indexing-queue')!.add('index', claim.payload, { jobId: claim.job_id, attempts: 3 });
      assert.equal((await done(accepted.run_id)).status, 'succeeded');
      await dispatcher.query('SELECT public.ack_indexing_dispatch($1,$2,false,100,1)', [claim.job_id, claim.dispatch_token]);
      const job = (await query('SELECT status,dispatch_state,last_error_code FROM public.processing_jobs WHERE id=$1', [claim.job_id])).rows[0];
      assert.equal(job.status, 'succeeded');
      assert.equal(job.dispatch_state, 'published');
      assert.equal(job.last_error_code, null);
    }
    finally {
      worker.dispatcher.start();
    }
  });
  it('enforces immutable index payloads and source-run references in PostgreSQL', async () => {
    const row = (await query("SELECT id FROM public.processing_jobs WHERE job_type='index' LIMIT 1")).rows[0];
    await assert.rejects(query("UPDATE public.processing_jobs SET payload=jsonb_set(payload,'{runId}',to_jsonb($2::text)) WHERE id=$1", [row.id, randomUUID()]), { code: '23514' });
    const id = randomUUID();
    await assert.rejects(query("INSERT INTO public.processing_jobs(id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,payload,dispatch_state) VALUES($1,$2,$3,'index','local-search-v1',$1::uuid::text,'indexing-queue',$1::uuid::text,$4,'pending')", [id, A, primary.id, JSON.stringify({ schemaVersion: 1, stage: 'index', jobId: id, tenantId: A, documentId: primary.id, runId: randomUUID() })]), { code: '23514' });
  });
  it('preserves vectors and source references across indexing migration rollback', async () => {
    await worker.app.close();
    const before = (await query('SELECT id FROM public.document_chunks ORDER BY id')).rows;
    const rollbackCount = (await migrationStatus(admin)).filter(item => item.status === 'applied').length - 8;
    await runMigrations(admin, { direction: 'down', count: rollbackCount });
    assert.deepEqual((await query('SELECT id FROM public.document_chunks ORDER BY id')).rows, before);
    assert.ok((await query("SELECT id FROM public.document_chunks WHERE source_reference ? 'rollback_original_source_version'")).rowCount! > 0);
    assert.equal((await runMigrations(admin)).length, rollbackCount);
  });
});
