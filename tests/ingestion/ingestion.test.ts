import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createDatabasePool, withTenantTransaction } from '@doc/database';
import { createMigrationPool, createDispatcherPool, provisionApplicationRole, provisionDispatcherRole, runMigrations, seedDevelopmentDatabase } from '@doc/database/admin';
import { createDocumentQueues, createObjectStorage, createRedis, loadEnvironment, projectRoot } from '@doc/core';
import { DOCUMENT_QUEUES, uploadAcceptedSchema, understandingResponseSchema } from '@doc/contracts';
import { buildApi } from '../fixtures/workspace-api.js';
import { selectWorkspace } from '../fixtures/workspace-api.js';
import { MIME_TYPES } from '../../apps/api/src/ingestion/files.js';
import { buildWorker } from '../../apps/worker/src/app.js';
import { IngestionOutbox } from '../../apps/worker/src/outbox.js';
import { IngestionProcessor } from '../../apps/worker/src/ingestion.js';
import { Worker } from 'bullmq';
import { registerExtractionTests } from './extraction-cases.js';
import { registerWorkflowTests } from './workflow-cases.js';
import { registerWorkspaceTests } from './workspace-cases.js';
import { registerFrontendTests } from './frontend-cases.js';

const execute = promisify(execFile);
const rootEnvironment = loadEnvironment();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const UA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const readerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const context = { tenantId: A, actorUserId: UA, reason: 'Ingestion integration test' };
const suffix = randomUUID().replaceAll('-', '');
const databaseName = 'di_ingestion_test_' + suffix;
const bucket = 'di-ingestion-test-' + suffix;
const cluster = createMigrationPool(rootEnvironment);
let fixtures: string;
let environment: typeof rootEnvironment;
let admin: ReturnType<typeof createMigrationPool>;
let database: ReturnType<typeof createDatabasePool>;
let dispatcherDatabase: ReturnType<typeof createDispatcherPool>;
let storage: ReturnType<typeof createObjectStorage>;
let api: ReturnType<typeof buildApi>;
let worker: ReturnType<typeof buildWorker>;
let inspector: ReturnType<typeof spawn>;
let workspace: string;
let otherWorkspace: string;
let readerWorkspace: string;
let apiAddress: string;
let databaseCreated = false;
let bucketCreated = false;
let acceptedIds: string[] = [];

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error('Timed out waiting for ingestion state');
}

type UploadFile = { filename: string; mime?: string; content: Buffer };
function multipart(files: UploadFile[]) {
  const boundary = 'test-' + randomUUID();
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + file.filename + '"\r\nContent-Type: ' + (file.mime ?? 'application/octet-stream') + '\r\n\r\n'));
    chunks.push(file.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}
async function fixture(extension: string): Promise<UploadFile> {
  const mime = MIME_TYPES['.' + extension];
  assert.ok(mime);
  return { filename: 'valid.' + extension, mime, content: await readFile(join(fixtures, 'valid.' + extension)) };
}
async function upload(files: UploadFile[], key = randomUUID(), instance = api, bearer = workspace) {
  const body = multipart(files);
  return instance.inject({ method: 'POST', url: '/v1/upload-batches', headers: { 'x-test-workspace':  bearer, 'content-type': body.contentType, 'idempotency-key': key }, payload: body.body });
}
function query(sql: string, values: unknown[] = []) { return withTenantTransaction(database, context, (client) => client.query(sql, values)); }

describe('real document ingestion, private storage, and durable queue dispatch', { concurrency: false }, () => {
  before(async () => {
    try {
    fixtures = await mkdtemp(join(tmpdir(), 'document-ingestion-test-'));
    const interpreter = process.env.PYTHON_EXECUTABLE;
    assert.ok(interpreter);
    await execute(interpreter, [join(projectRoot(), 'services/document-processor/tests/create_ingestion_fixtures.py'), fixtures]);
    await execute(interpreter, [join(projectRoot(), 'services/document-processor/tests/create_processing_fixtures.py'), fixtures]);
    await execute(interpreter, [join(projectRoot(), 'services/document-processor/tests/create_understanding_fixtures.py'), fixtures]);
    await provisionApplicationRole(cluster, rootEnvironment.POSTGRES_APP_PASSWORD);
    await provisionDispatcherRole(cluster, rootEnvironment.POSTGRES_DISPATCHER_PASSWORD);
    await cluster.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
    databaseCreated = true;
    const port = await availablePort();
    environment = { ...rootEnvironment, POSTGRES_DB: databaseName, S3_BUCKET: bucket, PROCESSOR_PORT: port,
      PROCESSOR_INTERNAL_TOKEN: randomBytes(32).toString('hex'), 
      QUEUE_PREFIX: 'di-ingestion-' + suffix, LOG_LEVEL: 'silent', UPLOAD_MAX_FILE_BYTES: 32_768, UPLOAD_MAX_BATCH_BYTES: 100_000,
      OUTBOX_POLL_MS: 100, OUTBOX_RECHECK_SECONDS: 1, INGESTION_BACKOFF_MS: 100, ANTIVIRUS_MODE: 'disabled',
      SEGMENTATION_AI_ENABLED: false, WORKFLOW_ENABLED:false,
      CLOUD_LLM_ENABLED: false, LOCAL_LLM_BASE_URL: '', LOCAL_LLM_MODEL: '', EXTRACTION_AUTO_START: false,
    };
    admin = createMigrationPool(environment);
    database = createDatabasePool(environment);
    dispatcherDatabase = createDispatcherPool(environment);
    await runMigrations(admin);
    await seedDevelopmentDatabase(admin, 'test');
    await admin.query("INSERT INTO public.users (id,tenant_id,email,display_name,role) VALUES ($1,$2,'reader@example.invalid','Read only','reader')", [readerId, A]);
    storage = createObjectStorage(environment, 5_000);
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    inspector = spawn(interpreter, ['-m', 'uvicorn', 'document_processor.main:app', '--app-dir', 'src', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
      cwd: join(projectRoot(), 'services/document-processor'),
      env: { ...process.env, PROCESSOR_INTERNAL_TOKEN: environment.PROCESSOR_INTERNAL_TOKEN, S3_BUCKET: bucket, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let inspectorErrors = '';
    inspector.stderr?.on('data', (data: Buffer) => { inspectorErrors = (inspectorErrors + data.toString()).slice(-2000); });
    await waitFor(async () => {
      if (inspector.exitCode !== null) throw new Error('Inspector startup failed: ' + inspectorErrors);
      try { return (await fetch('http://127.0.0.1:' + port + '/health')).ok; } catch { return false; }
    });
    api = buildApi(environment);
    await api.ready();
    apiAddress = await api.listen({ host: '127.0.0.1', port: 0 });
    workspace = await selectWorkspace(environment, { tenantId: A, userId: UA });
    otherWorkspace = await selectWorkspace(environment, { tenantId: B, userId: UB });
    readerWorkspace = await selectWorkspace(environment, { tenantId: A, userId: readerId });
    worker = buildWorker(environment);
    await worker.app.ready();
    await Promise.all([...worker.queues.values()].map((queue) => queue.waitUntilReady()));
    await worker.documents.waitUntilReady();
    await waitFor(async () => {
      try { await Promise.all([...worker.queues.values()].map((queue) => queue.getJobCounts())); return true; }
      catch { return false; }
    });
    } catch (error) {
      console.error('Ingestion test setup failed: ' + (error instanceof Error ? error.message : 'unknown error'));
      throw error;
    }
  });

  after(async () => {
    const errors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { errors.push(error); } };
    if (worker) await cleanup(() => worker.app.close());
    if (api) await cleanup(() => api.close());
    if (environment) await cleanup(async () => {
      const redis = createRedis(environment);
      try {
        await waitFor(async () => redis.status === 'ready');
        let cursor = '0';
        do {
          const result = await redis.scan(cursor, 'MATCH', environment.QUEUE_PREFIX + ':*', 'COUNT', 1000);
          cursor = result[0];
          if (result[1].length) await redis.del(...result[1]);
        } while (cursor !== '0');
      } finally { redis.disconnect(); }
    });
    if (storage && bucketCreated) await cleanup(async () => {
      const objects = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const object of objects.Contents ?? []) if (object.Key) await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
      storage.destroy();
    });
    if (inspector && inspector.exitCode === null) await cleanup(async () => {
      const stopped = new Promise<void>((resolve) => inspector.once('exit', () => resolve()));
      inspector.kill('SIGTERM');
      await stopped;
    });
    await cleanup(() => Promise.all([database?.end(), dispatcherDatabase?.end(), admin?.end()]));
    await cleanup(async () => { if (databaseCreated) await cluster.query('DROP DATABASE "' + databaseName + '" WITH (FORCE)'); });
    await cluster.end();
    if (fixtures) await rm(fixtures, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Ingestion test resource cleanup failed');
  });

  it('opens the configured workspace and denies read-only operator uploads', async () => {
    assert.equal((await api.inject('/v1/documents')).statusCode, 200);
    assert.equal((await api.inject({ url: '/v1/documents', headers: { authorization: 'Bearer forged' } })).statusCode, 200);
    assert.equal((await upload([await fixture('png')], randomUUID(), api, readerWorkspace)).statusCode, 403);
  });

  it('accepts a real HTTP multipart request with HTTP 202 and a batch location', async () => {
    const file = await fixture('png');
    const form = new FormData();
    form.set('files', new Blob([Buffer.from(file.content)], { type: file.mime! }), file.filename);
    const response = await fetch(apiAddress + '/v1/upload-batches', {
      method: 'POST', headers: { 'x-test-workspace':  workspace, 'idempotency-key': randomUUID() }, body: form,
    });
    assert.equal(response.status, 202, await response.clone().text());
    const accepted = uploadAcceptedSchema.parse(await response.json());
    assert.equal(response.headers.get('location'), '/v1/upload-batches/' + accepted.batchId);
  });

  it('accepts all nine supported extensions in a single real multipart upload', async () => {
    const files = await Promise.all(['pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'xlsx', 'xls', 'csv'].map(fixture));
    const response = await upload(files);
    assert.equal(response.statusCode, 202, response.body);
    const accepted = uploadAcceptedSchema.parse(response.json());
    assert.equal(accepted.documents.length, 9);
    assert.equal(new Set(accepted.documents.map((document) => document.id)).size, 9);
    acceptedIds = accepted.documents.map((document) => document.id);
    for (const [index, document] of accepted.documents.entries()) {
      assert.equal(document.sha256, createHash('sha256').update(files[index]!.content).digest('hex'));
      assert.equal(document.antivirus?.status, 'not_scanned');
    }
  });

  it('stores private bytes and compact, stable jobs without document contents', async () => {
    await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=ANY($1::uuid[]) AND processing_status='processed'", [acceptedIds])).rowCount === 9);
    const records = (await query('SELECT d.*,j.id AS job_id,j.queue_job_id,j.payload,j.status AS job_status FROM public.documents d JOIN public.processing_jobs j ON j.document_id=d.id WHERE d.id=ANY($1::uuid[])', [acceptedIds])).rows;
    assert.equal(records.length, 9);
    for (const record of records) {
      assert.equal(record.queue_job_id, record.job_id);
      assert.equal(record.job_status, 'succeeded');
      assert.ok(Buffer.byteLength(JSON.stringify(record.payload)) < 4096);
      assert.ok(!('file' in record.payload) && !('extractedText' in record.payload));
      assert.match(record.object_storage_key, new RegExp('^tenants/' + A + '/documents/' + record.id + '/source\\.'));
    }
    const record = records[0]!;
    const object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: record.object_storage_key }));
    assert.equal(createHash('sha256').update(await object.Body!.transformToByteArray()).digest('hex'), record.sha256);
    const anonymous = await fetch(environment.S3_ENDPOINT + '/' + bucket + '/' + record.object_storage_key);
    assert.equal(anonymous.status, 403);
    await anonymous.body?.cancel();
    for (const name of DOCUMENT_QUEUES) assert.ok(worker.queues.has(name));
    for (const name of DOCUMENT_QUEUES.filter((name) => name !== 'document-queue')) assert.equal(await worker.queues.get(name)!.getWaitingCount(), 0);
  });

  it('extracts digital/scanned PDF pages, OCR images, worksheets and CSV into PostgreSQL evidence', async () => {
    const files = await Promise.all(['pdf', 'png', 'xlsx', 'csv'].map(async (extension) => ({
      filename: 'process.' + extension, mime: MIME_TYPES['.' + extension]!, content: await readFile(join(fixtures, 'process.' + extension)),
    })));
    const larger = buildApi({ ...environment, UPLOAD_MAX_FILE_BYTES: 1_048_576, UPLOAD_MAX_BATCH_BYTES: 4_194_304 });
    await larger.ready();
    try {
      const response = await upload(files, randomUUID(), larger);
      assert.equal(response.statusCode, 202, response.body);
      const documents = uploadAcceptedSchema.parse(response.json()).documents;
      const ids = documents.map((document) => document.id);
      await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=ANY($1::uuid[]) AND processing_status='processed'", [ids])).rowCount === 4);
      const pdf = documents[0]!;
      const pages = (await query('SELECT * FROM public.document_pages WHERE document_id=$1 ORDER BY page_number', [pdf.id])).rows;
      assert.deepEqual(pages.map((page) => page.extraction_method), ['digital', 'ocr']);
      assert.match(pages[0].extracted_text, /Digital invoice/);
      assert.match(pages[1].extracted_text, /1250/);
      assert.equal(pages[1].source_reference.pdf_page, 2);
      const ocr = (await query('SELECT * FROM public.document_blocks WHERE document_id=$1 AND extraction_method=$2', [pdf.id, 'ocr'])).rows;
      assert.ok(ocr.length > 0 && ocr.every((block) => block.bounding_box?.length === 4 && Number(block.ocr_confidence) >= 0));
      const sheetPages = (await query('SELECT worksheet_name FROM public.document_pages WHERE document_id=$1 ORDER BY page_number', [documents[2]!.id])).rows;
      assert.deepEqual(sheetPages.map((page) => page.worksheet_name), ['Invoices', 'Second']);
      const formula = (await query('SELECT * FROM public.document_blocks WHERE document_id=$1 AND worksheet_name=$2 AND cell_range=$3', [documents[2]!.id, 'Invoices', 'C2'])).rows[0];
      assert.equal(formula.source_reference.cell.formula, '=B2+10');
      assert.equal(formula.source_reference.cell.cached_value, null);
      const missing = (await query('SELECT * FROM public.document_blocks WHERE document_id=$1 AND cell_range=$2', [documents[3]!.id, 'C2'])).rows[0];
      assert.equal(missing.source_reference.cell.value, null);
      assert.equal(missing.source_reference.cell.column, 3);
    } finally { await larger.close(); }
  });

  it('retrieves authenticated private compressed artifacts and keeps successful job replays idempotent', async () => {
    const documentId = acceptedIds[0]!;
    const row = (await query('SELECT * FROM public.processing_jobs WHERE document_id=$1', [documentId])).rows[0];
    const path = `/internal/artifacts/${A}/${documentId}/${row.checkpoint.runId}/manifest.json`;
    const base = 'http://127.0.0.1:' + environment.PROCESSOR_PORT;
    assert.equal((await fetch(base + path)).status, 401);
    const headers = { authorization: 'Bearer ' + environment.PROCESSOR_INTERNAL_TOKEN };
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    const manifest = await response.json() as { artifacts: { name: string; key: string; sha256: string }[]; document_id: string };
    assert.equal(manifest.document_id, documentId);
    const part = manifest.artifacts[0]!;
    const artifact = await fetch(base + path.replace('manifest.json', part.name), { headers });
    assert.equal(artifact.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await artifact.arrayBuffer())).digest('hex'), part.sha256);
    const anonymous = await fetch(environment.S3_ENDPOINT + '/' + bucket + '/' + part.key);
    assert.equal(anonymous.status, 403);
    await anonymous.body?.cancel();
    const wrongTenant = await fetch(base + path.replace('/' + A + '/', '/' + B + '/'), { headers });
    assert.equal(wrongTenant.status, 404);
    await wrongTenant.body?.cancel();
    const count = (await query('SELECT count(*) AS total FROM public.document_pages WHERE document_id=$1', [documentId])).rows[0].total;
    const job = await worker.queues.get('document-queue')!.getJob(row.id);
    assert.ok(job);
    const processor = new IngestionProcessor(database, storage, environment);
    assert.equal((await processor.process(job)).stage, 'document_processing_complete');
    assert.equal((await query('SELECT count(*) AS total FROM public.document_pages WHERE document_id=$1', [documentId])).rows[0].total, count);
  });

  it('classifies real PDFs and groups multi-page invoices without losing ambiguous pages', async () => {
    for (const [filename, expectedType, groups] of [
      ['single-invoice.pdf', 'invoice', [[1]]], ['multi-invoice.pdf', 'invoice_bundle', [[1, 2], [3]]],
      ['ambiguous-invoice.pdf', 'unknown', [[1], [2]]], ['receipt.pdf', 'receipt', [[1]]], ['business.pdf', 'other', [[1]]],
    ] as const) {
      const response = await upload([{ filename, content: await readFile(join(fixtures, filename)) }]);
      assert.equal(response.statusCode, 202, response.body);
      const id = response.json().documents[0].id;
      await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='processed'", [id])).rowCount === 1);
      const output = await api.inject({ method: 'GET', url: '/v1/documents/' + id + '/understanding', headers: { 'x-test-workspace':  workspace } });
      assert.equal(output.statusCode, 200, output.body);
      const understanding = understandingResponseSchema.parse(output.json());
      assert.deepEqual(understanding.candidates.map((candidate) => candidate.source_pages), groups);
      assert.equal(understanding.run?.ai_status, 'disabled');
      if (filename === 'ambiguous-invoice.pdf') assert.ok(understanding.run?.requires_manual_review);
      assert.equal((await query('SELECT document_type FROM public.documents WHERE id=$1', [id])).rows[0].document_type, expectedType);
    }
  });

  it('preserves XLSX/XLS/CSV invoice tables, ranges and tenant-safe paginated candidates', async () => {
    for (const [filename, expected] of [['invoice-tables.xlsx', 3], ['invoice-records.xls', 2], ['invoice-records.csv', 2]] as const) {
      const response = await upload([{ filename, content: await readFile(join(fixtures, filename)) }]);
      assert.equal(response.statusCode, 202, response.body);
      const id = response.json().documents[0].id;
      await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='processed'", [id])).rowCount === 1);
      const headers = { 'x-test-workspace':  workspace };
      const base = '/v1/documents/' + id + '/understanding';
      const output = await api.inject({ method: 'GET', url: base + '?limit=1', headers });
      const first = understandingResponseSchema.parse(output.json());
      assert.equal(first.run?.invoice_candidate_count, expected);
      assert.equal(first.candidates.length, 1); assert.ok(first.next_cursor);
      assert.ok(first.candidates[0]!.source_locations[0]!.cell_range?.startsWith('A1:'));
      const second = understandingResponseSchema.parse((await api.inject({ method: 'GET', url: base + '?cursor=' + first.next_cursor, headers })).json());
      assert.equal(second.candidates.length, expected - 1);
      assert.ok(second.candidates.every((candidate) => candidate.document_type === 'invoice' && candidate.source_worksheets.length > 0));
      assert.equal((await api.inject({ method: 'GET', url: base, headers: { 'x-test-workspace':  otherWorkspace } })).statusCode, 404);
      assert.equal((await api.inject({ method: 'GET', url: base })).statusCode, 200);
      assert.equal((await api.inject({ method: 'GET', url: base + '?cursor=invalid', headers })).statusCode, 400);
      assert.equal((await api.inject({ method: 'GET', url: base + '?limit=101', headers })).statusCode, 400);
      const runs = (await query('SELECT id FROM public.document_understanding_runs WHERE document_id=$1', [id])).rows;
      assert.equal(runs.length, 1);
    }
  });

  it('returns a clear empty understanding result before processing instead of inventing candidates', async () => {
    await worker.documents.pause();
    try {
      const uploadResult = await upload([await fixture('png')]);
      const id = uploadResult.json().documents[0].id;
      const output = await api.inject({ method: 'GET', url: '/v1/documents/' + id + '/understanding', headers: { 'x-test-workspace':  workspace } });
      assert.deepEqual(understandingResponseSchema.parse(output.json()), { document_id: id, run: null, candidates: [], next_cursor: null });
    } finally { await worker.documents.resume(); }
  });

  it('rejects unsupported extensions and declared MIME spoofing', async () => {
    const png = await fixture('png');
    assert.equal((await upload([{ ...png, filename: 'payload.exe' }])).statusCode, 415);
    assert.equal((await upload([{ ...png, mime: 'application/pdf' }])).statusCode, 415);
  });
  it('rejects real signature mismatches, corrupt archives, binary CSV, and encrypted PDFs', async () => {
    for (const [filename, targetName] of [['fake.pdf', 'invoice.pdf'], ['fake.xlsx', 'invoice.xlsx'], ['fake.xls', 'invoice.xls'], ['encrypted.pdf', 'invoice.pdf']] as const) {
      const response = await upload([{ filename: targetName, content: await readFile(join(fixtures, filename)) }]);
      assert.ok([415, 422].includes(response.statusCode), response.body);
    }
    assert.equal((await upload([{ filename: 'fake.csv', content: Buffer.from([0, 1, 2, 3]) }])).statusCode, 415);
  });
  it('rejects path traversal without using client filenames as storage paths', async () => {
    const png = await fixture('png');
    assert.equal((await upload([{ ...png, filename: '../escape.png' }])).statusCode, 400);
    assert.equal((await upload([{ ...png, filename: '..\\escape.png' }])).statusCode, 400);
  });
  it('rejects oversized files, too many files, and oversized batches', async () => {
    assert.equal((await upload([{ filename: 'huge.csv', content: Buffer.alloc(environment.UPLOAD_MAX_FILE_BYTES + 1, 65) }])).statusCode, 413);
    const limited = buildApi({ ...environment, UPLOAD_MAX_FILES: 1, UPLOAD_MAX_BATCH_BYTES: 1_000 });
    await limited.ready();
    try {
      assert.equal((await upload([await fixture('png'), await fixture('png')], randomUUID(), limited)).statusCode, 413);
      assert.equal((await upload([{ filename: 'big.csv', content: Buffer.alloc(1_001, 65) }], randomUUID(), limited)).statusCode, 413);
    } finally { await limited.close(); }
  });
  it('applies configured PDF, TIFF, and worksheet page limits', async () => {
    const limited = buildApi({ ...environment, UPLOAD_MAX_PAGES: 1 });
    await limited.ready();
    try {
      for (const extension of ['pdf', 'tiff', 'xlsx', 'xls']) {
        const response = await upload([await fixture(extension)], randomUUID(), limited);
        assert.equal(response.statusCode, 413, extension + ': ' + response.body);
      }
    }
    finally { await limited.close(); }
  });
  it('keeps a mixed invalid batch atomic', async () => {
    const count = Number((await query('SELECT count(*) FROM public.documents')).rows[0].count);
    const result = await upload([await fixture('png'), { filename: 'fake.pdf', content: Buffer.from('not PDF') }]);
    assert.equal(result.statusCode, 415);
    assert.equal(Number((await query('SELECT count(*) FROM public.documents')).rows[0].count), count);
  });
  it('bounds the complete raw multipart request including excess preamble bytes', async () => {
    const limited = buildApi({ ...environment, UPLOAD_MAX_FILES: 1, UPLOAD_MAX_BATCH_BYTES: 1_000 });
    await limited.ready();
    const address = await limited.listen({ host: '127.0.0.1', port: 0 });
    try {
      const form = multipart([await fixture('png')]);
      const response = await fetch(address + '/v1/upload-batches', { method: 'POST',
        headers: { 'x-test-workspace':  workspace, 'content-type': form.contentType },
        body: Buffer.concat([Buffer.alloc(20_000, 65), form.body]),
      });
      assert.equal(response.status, 413, await response.text());
    } finally { await limited.close(); }
  });
  it('stores duplicate files as separate documents with duplicate-content hints', async () => {
    const response = await upload([await fixture('png'), await fixture('png')]);
    assert.equal(response.statusCode, 202, response.body);
    const documents = uploadAcceptedSchema.parse(response.json()).documents;
    assert.notEqual(documents[0]!.id, documents[1]!.id);
    assert.equal(documents[0]!.sha256, documents[1]!.sha256);
    assert.ok(documents.every((document) => document.duplicateOfDocumentId));
  });
  it('replays idempotent uploads without new documents, objects, or jobs and rejects conflicting reuse', async () => {
    const key = randomUUID();
    const file = await fixture('csv');
    const first = await upload([file], key);
    assert.equal(first.statusCode, 202, first.body);
    const before = Number((await query('SELECT count(*) FROM public.processing_jobs')).rows[0].count);
    const replay = await upload([file], key);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().batchId, first.json().batchId);
    assert.equal(replay.json().documents[0].id, first.json().documents[0].id);
    assert.equal(Number((await query('SELECT count(*) FROM public.processing_jobs')).rows[0].count), before);
    assert.equal((await upload([{ ...file, filename: 'renamed.csv' }], key)).statusCode, 409);
  });
  it('handles concurrent requests with the same idempotency key without duplicating accepted records', async () => {
    const key = randomUUID();
    const file = await fixture('png');
    const responses = await Promise.all([upload([file], key), upload([file], key)]);
    assert.ok(responses.some((response) => response.statusCode === 202));
    assert.ok(responses.every((response) => [202, 409].includes(response.statusCode)), responses.map((response) => response.body).join('\n'));
    assert.equal((await query('SELECT id FROM public.upload_batches WHERE idempotency_key=$1', [key])).rowCount, 1);
    const replay = await upload([file], key);
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().replayed, true);
  });
  it('provides tenant-isolated list/detail/status/batch APIs and stable pagination', async () => {
    const id = acceptedIds[0]!;
    for (const path of ['/v1/documents/' + id, '/v1/documents/' + id + '/status']) {
      assert.equal((await api.inject({ url: path, headers: { 'x-test-workspace':  workspace } })).statusCode, 200);
      assert.equal((await api.inject({ url: path, headers: { 'x-test-workspace':  otherWorkspace } })).statusCode, 404);
    }
    const page = await api.inject({ url: '/v1/documents?limit=2', headers: { 'x-test-workspace':  workspace } });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().documents.length, 2);
    assert.ok(page.json().nextCursor);
    const second = await api.inject({ url: '/v1/documents?limit=2&cursor=' + page.json().nextCursor, headers: { 'x-test-workspace':  workspace } });
    assert.equal(second.statusCode, 200, second.body);
    assert.ok(second.json().documents.every((document: { id: string }) => !page.json().documents.some((first: { id: string }) => first.id === document.id)));
    assert.equal((await api.inject({ url: '/v1/documents?unexpected=1', headers: { 'x-test-workspace':  workspace } })).statusCode, 400);
    const detail = (await api.inject({ url: '/v1/documents/' + id, headers: { 'x-test-workspace':  workspace } })).json();
    assert.ok(detail.inspection.pageCount > 0);
    assert.ok(!('objectStorageKey' in detail.document));
    assert.equal((await api.inject({ url: '/v1/upload-batches/' + detail.document.uploadBatchId, headers: { 'x-test-workspace':  workspace } })).statusCode, 200);
  });
  it('fails closed when configured antivirus is unavailable', async () => {
    const unavailable = buildApi({ ...environment, ANTIVIRUS_MODE: 'clamav', CLAMAV_PORT: await availablePort(), CLAMAV_TIMEOUT_MS: 1000 });
    await unavailable.ready();
    try {
      const result = await upload([await fixture('png')], randomUUID(), unavailable);
      assert.equal(result.statusCode, 503, result.body);
      assert.equal(result.json().error.code, 'ANTIVIRUS_UNAVAILABLE');
    } finally { await unavailable.close(); }
  });
  it('recovers failed storage reservations with the same document identities', async () => {
    const failed = buildApi({ ...environment, S3_ENDPOINT: 'http://127.0.0.1:' + await availablePort() });
    await failed.ready();
    const key = randomUUID();
    const file = await fixture('png');
    try { assert.equal((await upload([file], key, failed)).statusCode, 503); }
    finally { await failed.close(); }
    const reserved = (await query('SELECT d.id FROM public.documents d JOIN public.upload_batches b ON b.id=d.upload_batch_id WHERE b.idempotency_key=$1', [key])).rows[0].id;
    const recovered = await upload([file], key);
    assert.equal(recovered.statusCode, 202, recovered.body);
    assert.equal(recovered.json().documents[0].id, reserved);
  });
  it('retains accepted uploads during queue failure and dispatches after recovery', async () => {
    await worker.dispatcher.stop();
    const key = randomUUID();
    const result = await upload([await fixture('csv')], key);
    assert.equal(result.statusCode, 202, result.body);
    const id = result.json().documents[0].id;
    const offlineEnvironment = { ...environment, REDIS_PORT: await availablePort() };
    const offlineQueues = createDocumentQueues(offlineEnvironment);
    const offlineDispatcher = new IngestionOutbox(dispatcherDatabase, offlineQueues.queues, offlineEnvironment);
    try { await offlineDispatcher.dispatchOnce(); }
    finally { await offlineQueues.close(); }
    const retained = (await query('SELECT j.dispatch_state,j.dispatch_failures,j.id FROM public.processing_jobs j WHERE j.document_id=$1', [id])).rows[0];
    assert.equal(retained.dispatch_state, 'retry_wait');
    assert.equal(retained.dispatch_failures, 1);
    await delay(150);
    await worker.dispatcher.dispatchOnce();
    worker.dispatcher.start();
    await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='processed'", [id])).rowCount === 1);
    const recovered = (await query('SELECT id,queue_job_id FROM public.processing_jobs WHERE document_id=$1', [id])).rows[0];
    assert.equal(recovered.id, retained.id);
    assert.equal(recovered.queue_job_id, retained.id);
  });
  it('persists failed-job state when stored-object verification fails', async () => {
    await worker.documents.pause();
    const result = await upload([await fixture('png')]);
    assert.equal(result.statusCode, 202, result.body);
    const id = result.json().documents[0].id;
    const record = (await query('SELECT * FROM public.documents WHERE id=$1', [id])).rows[0];
    await storage.send(new PutObjectCommand({ Bucket: bucket, Key: record.object_storage_key, Body: Buffer.alloc(Number(record.file_size_bytes)), ContentType: record.mime_type, Metadata: { 'tenant-id': A, 'document-id': id, sha256: record.sha256 } }));
    await worker.documents.resume();
    await waitFor(async () => (await query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='failed'", [id])).rowCount === 1);
    const job = (await query('SELECT * FROM public.processing_jobs WHERE document_id=$1', [id])).rows[0];
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 1);
    assert.equal(job.last_error_code, 'OBJECT_CHECKSUM_MISMATCH');
    assert.ok(job.finished_at);
  });
  it('recovers a lost publish acknowledgment and deleted Redis job with its original job ID', async () => {
    await worker.dispatcher.stop();
    await worker.documents.pause();
    try {
      const response = await upload([await fixture('csv')]);
      assert.equal(response.statusCode, 202, response.body);
      const documentId = response.json().documents[0].id;
      const row = (await query('SELECT * FROM public.processing_jobs WHERE document_id=$1', [documentId])).rows[0];
      const claims = await dispatcherDatabase.query('SELECT * FROM public.claim_ingestion_dispatches(10,30)');
      const claim = claims.rows.find((item) => item.job_id === row.id);
      assert.ok(claim);
      const queue = worker.queues.get('document-queue')!;
      await queue.add('ingest', claim.payload, { jobId: row.id });
      await query("UPDATE public.processing_jobs SET dispatch_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
      await worker.dispatcher.dispatchOnce();
      assert.equal((await query('SELECT dispatch_state FROM public.processing_jobs WHERE id=$1', [row.id])).rows[0].dispatch_state, 'published');
      await (await queue.getJob(row.id))!.remove();
      await query('UPDATE public.processing_jobs SET dispatch_available_at=clock_timestamp() WHERE id=$1', [row.id]);
      await worker.dispatcher.dispatchOnce();
      assert.ok(await queue.getJob(row.id));
      await worker.documents.resume();
      worker.dispatcher.start();
      await waitFor(async () => (await query("SELECT id FROM public.processing_jobs WHERE id=$1 AND status='succeeded'", [row.id])).rowCount === 1);
      assert.equal((await query('SELECT attempts FROM public.processing_jobs WHERE id=$1', [row.id])).rows[0].attempts, 1);
    } finally { await worker.documents.resume(); worker.dispatcher.start(); }
  });
  it('persists a terminal failure after bounded queue-dispatch retries', async () => {
    await worker.dispatcher.stop();
    const limited = buildApi({ ...environment, OUTBOX_MAX_FAILURES: 2 });
    await limited.ready();
    const offlineQueues = createDocumentQueues({ ...environment, REDIS_PORT: await availablePort() });
    const offlineDispatcher = new IngestionOutbox(dispatcherDatabase, offlineQueues.queues, environment);
    try {
      const response = await upload([await fixture('csv')], randomUUID(), limited);
      assert.equal(response.statusCode, 202, response.body);
      const id = response.json().documents[0].id;
      await offlineDispatcher.dispatchOnce();
      await delay(150);
      await offlineDispatcher.dispatchOnce();
      const row = (await query('SELECT * FROM public.processing_jobs WHERE document_id=$1', [id])).rows[0];
      assert.equal(row.dispatch_failures, 2);
      assert.equal(row.dispatch_state, 'dead');
      assert.equal(row.status, 'failed');
      assert.ok(row.finished_at);
      assert.equal((await query('SELECT processing_status FROM public.documents WHERE id=$1', [id])).rows[0].processing_status, 'failed');
    } finally { await offlineQueues.close(); await limited.close(); worker.dispatcher.start(); }
  });
  it('bounds real worker retries and retains exponential-backoff configuration', async () => {
    await worker.documents.pause();
    const unavailableStorage = createObjectStorage({ ...environment, S3_ENDPOINT: 'http://127.0.0.1:' + await availablePort() }, 1_000);
    const connection = createRedis(environment, true);
    const processor = new IngestionProcessor(database, unavailableStorage, environment);
    const consumer = new Worker('document-queue', (job, lease) => processor.process(job, lease), { connection, prefix: environment.QUEUE_PREFIX });
    consumer.on('error', () => undefined);
    try {
      await consumer.waitUntilReady();
      const response = await upload([await fixture('png')]);
      assert.equal(response.statusCode, 202, response.body);
      const id = response.json().documents[0].id;
      await waitFor(async () => (await query("SELECT id FROM public.processing_jobs WHERE document_id=$1 AND status='failed'", [id])).rowCount === 1);
      const row = (await query('SELECT * FROM public.processing_jobs WHERE document_id=$1', [id])).rows[0];
      assert.equal(row.attempts, environment.INGESTION_JOB_ATTEMPTS);
      assert.equal(row.last_error_code, 'STORAGE_UNAVAILABLE');
      const queued = await worker.queues.get('document-queue')!.getJob(row.id);
      assert.equal(queued?.opts.attempts, environment.INGESTION_JOB_ATTEMPTS);
      assert.deepEqual(queued?.opts.backoff, { type: 'exponential', delay: environment.INGESTION_BACKOFF_MS });
    } finally { await consumer.close(); connection.disconnect(); unavailableStorage.destroy(); await worker.documents.resume(); }
  });
  it('limits dispatcher privileges to the leased outbox functions', async () => {
    await assert.rejects(dispatcherDatabase.query('SELECT * FROM public.documents'), { code: '42501' });
    await assert.rejects(database.query('SELECT * FROM public.claim_ingestion_dispatches(1,30)'), { code: '42501' });
  });
  registerExtractionTests(() => ({ environment, database, admin, fixtures, api, worker, workspace, otherWorkspace, readerWorkspace, query, waitFor, upload }));
  registerWorkflowTests(() => ({ environment, database, fixtures, worker, workspace, otherWorkspace, readerWorkspace, query, waitFor }));
  registerWorkspaceTests(() => ({ environment, database, fixtures, workspace, otherWorkspace, readerWorkspace, query, waitFor }));
  if(process.env.DOC_FRONTEND_TESTS==='1')registerFrontendTests(() => ({ environment, database, fixtures, workspace, otherWorkspace, readerWorkspace, query, waitFor }));
});
