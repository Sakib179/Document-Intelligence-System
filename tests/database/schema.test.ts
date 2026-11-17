import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { loadEnvironment } from '@doc/core';
import { createDatabasePool, withTenantTransaction, withTransaction, enqueueInvoiceExtractions } from '@doc/database';
import type { TenantContext } from '@doc/database';
import {
  createMigrationPool, migrationsDirectory, migrationStatus, provisionApplicationRole, provisionDispatcherRole,
  runMigrations, seedDevelopmentDatabase,
} from '@doc/database/admin';

const environment = loadEnvironment();
const cluster = createMigrationPool(environment);
const databaseName = 'di_schema_test_' + Date.now() + '_' + randomUUID().slice(0, 8);
const migrationCount = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).length;
let admin: pg.Pool;
let runtime: pg.Pool;
let created = false;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const UA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = '20000000-0000-4000-8000-000000000001';
const D2 = '20000000-0000-4000-8000-000000000002';
const D3 = '20000000-0000-4000-8000-000000000003';
const P1 = '41000000-0000-4000-8000-000000000001';
const P2 = '41000000-0000-4000-8000-000000000002';
const I1 = '50000000-0000-4000-8000-000000000001';
const L1 = '60000000-0000-4000-8000-000000000001';
const E1 = '40000000-0000-4000-8000-000000000001';
const V1 = '70000000-0000-4000-8000-000000000001';
const R1 = '80000000-0000-4000-8000-000000000001';
const RI1 = '81000000-0000-4000-8000-000000000001';
const context: TenantContext = { tenantId: A, actorUserId: UA, reason: 'Database integration test' };
const tables = [
  'tenants', 'users', 'upload_batches', 'documents', 'document_pages', 'document_blocks',
  'invoices', 'invoice_line_items', 'extraction_runs', 'validation_issues',
  'reconciliation_runs', 'reconciliation_items', 'document_chunks', 'processing_jobs', 'audit_events',
  'document_understanding_runs', 'invoice_candidates',
  'extraction_attempts', 'llm_provider_health', 'financial_validation_runs', 'indexing_runs',
];

async function rollbackScope<T>(operation: (client: pg.PoolClient) => Promise<T>, tenant = context): Promise<T> {
  const rollback = new Error('Rollback successful test writes');
  let result: T | undefined;
  try {
    await withTenantTransaction(runtime, tenant, async (client) => {
      result = await operation(client);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  return result as T;
}

function tenantQuery(sql: string, values: unknown[] = [], tenant = context) {
  return withTenantTransaction(runtime, tenant, (client) => client.query(sql, values));
}

async function understandingFixture(client: pg.PoolClient) {
  const runId = randomUUID(), candidateId = randomUUID();
  await client.query("INSERT INTO public.document_understanding_runs (id,tenant_id,document_id,processing_job_id,source_version,manifest_key,algorithm_version,document_type,segmentation_confidence,requires_manual_review,candidate_count,invoice_candidate_count,ai_status) VALUES ($1,$2,$3,'30000000-0000-4000-8000-000000000001',1,'development-fixture/not-executed','segmentation-v1','invoice',0.96,false,1,1,'disabled')", [runId, A, D1]);
  const data = { candidate_id: candidateId, document_id: D1, document_type: 'invoice', source_pages: [1], source_worksheets: [],
    source_locations: [{ page_number: 1, source_kind: 'pdf_page', worksheet_name: null, row_start: null, row_end: null, cell_range: null,
      artifact: 'development-fixture/not-executed', artifact_line: 1, end_artifact: 'development-fixture/not-executed', end_artifact_line: 1 }],
    segmentation_confidence: 0.96, requires_manual_review: false, review_reasons: [], evidence: [], advisor_suggestion: null };
  await client.query("INSERT INTO public.invoice_candidates (id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) VALUES ($1,$2,$3,$4,1,'invoice',0.96,false,$5)", [candidateId, A, D1, runId, JSON.stringify(data)]);
  return { runId, candidateId, data };
}

async function extractionAttemptFixture(client: pg.PoolClient) {
  const fixture = await understandingFixture(client), runId = randomUUID(), attemptId = randomUUID();
  await client.query("INSERT INTO public.extraction_runs (id,tenant_id,document_id,candidate_id,understanding_run_id,status,started_at,prompt_version,schema_version) VALUES ($1,$2,$3,$4,$5,'running',clock_timestamp(),'invoice-extraction-v1','invoice-extraction-v1')", [runId,A,D1,fixture.candidateId,fixture.runId]);
  await client.query("INSERT INTO public.extraction_attempts (id,tenant_id,document_id,extraction_run_id,provider,model_id,prompt_version,attempt_number,fallback_used,status,input_sha256,policy_snapshot) VALUES ($1,$2,$3,$4,'local_qwen','qwen-fixture','invoice-extraction-v1',1,false,'running',repeat('b',64),'{\"classification\":\"confidential\"}')", [attemptId,A,D1,runId]);
  return { ...fixture, extractionRunId: runId, attemptId };
}

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables) {
    // The identifier comes exclusively from the constant table list above.
    result[table] = Number((await admin.query('SELECT count(*) AS count FROM public.' + table)).rows[0].count);
  }
  return result;
}

describe('initial PostgreSQL schema against an isolated database', { concurrency: false }, () => {
  before(async () => {
    await provisionApplicationRole(cluster, environment.POSTGRES_APP_PASSWORD);
    await provisionDispatcherRole(cluster, environment.POSTGRES_DISPATCHER_PASSWORD);
    assert.match(databaseName, /^di_schema_test_[0-9]+_[a-f0-9]+$/);
    await cluster.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
    created = true;
    admin = createMigrationPool(environment, { database: databaseName });
    runtime = createDatabasePool(environment, { database: databaseName, max: 1 });
    assert.equal((await runMigrations(admin)).length, migrationCount);
    await seedDevelopmentDatabase(admin, 'test');
  });

  after(async () => {
    if (runtime) await runtime.end();
    if (admin) await admin.end();
    try {
      if (created) await cluster.query('DROP DATABASE "' + databaseName + '" WITH (FORCE)');
    } finally { await cluster.end(); }
  });

  it('creates core and understanding tables with forced row-level security', async () => {
    const result = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])", [tables],
    );
    assert.equal(result.rowCount, tables.length);
    assert.ok(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  });

  it('runs application queries through a nonowner role without elevated privileges', async () => {
    const result = await runtime.query("SELECT current_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user");
    assert.equal(result.rows[0].current_user, 'document_intelligence_app');
    for (const key of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb']) assert.equal(result.rows[0][key], false);
    await assert.rejects(runtime.query('SET ROLE "' + environment.POSTGRES_USER.replaceAll('"', '""') + '"'), { code: '42501' });
  });

  it('preserves immutable understanding candidates and isolates their tenant views', async () => {
    await rollbackScope(async (client) => {
      const fixture = await understandingFixture(client);
      assert.equal((await client.query('SELECT id FROM public.invoice_candidates WHERE id=$1', [fixture.candidateId])).rowCount, 1);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [B]);
      assert.equal((await client.query('SELECT id FROM public.invoice_candidates WHERE id=$1', [fixture.candidateId])).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM public.document_understanding_runs WHERE id=$1', [fixture.runId])).rowCount, 0);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [A]);
    });
    await assert.rejects(rollbackScope(async (client) => {
      const fixture = await understandingFixture(client);
      await client.query('UPDATE public.invoice_candidates SET requires_manual_review=true WHERE id=$1', [fixture.candidateId]);
    }), { code: '42501' });
  });

  it('rejects mismatched candidate identity and cross-document run references', async () => {
    await assert.rejects(rollbackScope(async (client) => {
      const fixture = await understandingFixture(client);
      await client.query("INSERT INTO public.invoice_candidates (id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) VALUES ($1,$2,$3,$4,2,'invoice',0.96,false,$5)", [randomUUID(), A, D1, fixture.runId, JSON.stringify(fixture.data)]);
    }), { code: '23514' });
    await assert.rejects(rollbackScope(async (client) => {
      const fixture = await understandingFixture(client), id = randomUUID();
      await client.query("INSERT INTO public.invoice_candidates (id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) VALUES ($1,$2,$3,$4,2,'invoice',0.96,false,$5)", [id, A, D2, fixture.runId, JSON.stringify({ ...fixture.data, candidate_id: id, document_id: D2 })]);
    }), { code: '23503' });
  });

  it('rolls back understanding snapshots and their audit events atomically', async () => {
    const before = await counts();
    const fixture = await rollbackScope(understandingFixture);
    assert.equal((await admin.query('SELECT id FROM public.document_understanding_runs WHERE id=$1', [fixture.runId])).rowCount, 0);
    assert.deepEqual(await counts(), before);
  });

  it('denies all tenant rows when no tenant context is supplied', async () => {
    for (const table of tables) assert.equal((await runtime.query('SELECT id FROM public.' + table)).rowCount, 0, table);
  });

  it('isolates tenant reads and hides foreign invoice identifiers', async () => {
    assert.equal((await tenantQuery('SELECT id FROM public.documents')).rowCount, 2);
    const tenantB = { tenantId: B, actorUserId: UB };
    assert.equal((await tenantQuery('SELECT id FROM public.documents', [], tenantB)).rowCount, 1);
    assert.equal((await tenantQuery('SELECT id FROM public.invoices WHERE id = $1', [I1], tenantB)).rowCount, 0);
    assert.equal((await tenantQuery('SELECT id FROM public.tenants')).rowCount, 1);
    assert.equal((await tenantQuery('SELECT id FROM public.users')).rowCount, 1);
  });

  it('prevents cross-tenant updates and inserts', async () => {
    const tenantB = { tenantId: B, actorUserId: UB, reason: 'Attempted foreign update' };
    assert.equal((await tenantQuery('UPDATE public.invoices SET total = 1 WHERE id = $1 RETURNING id', [I1], tenantB)).rowCount, 0);
    await assert.rejects(tenantQuery(
      "INSERT INTO public.documents (tenant_id, original_filename, mime_type, file_size_bytes, sha256, object_storage_key) VALUES ($1, 'foreign.pdf', 'application/pdf', 1, repeat('a',64), 'foreign')", [B],
    ), { code: '42501' });
  });

  it('enforces tenant-aware foreign keys even when all referenced UUIDs exist', async () => {
    await assert.rejects(tenantQuery(
      "INSERT INTO public.documents (tenant_id, upload_batch_id, original_filename, mime_type, file_size_bytes, sha256, object_storage_key) VALUES ($1, $2, 'foreign.pdf', 'application/pdf', 1, repeat('a',64), 'foreign')",
      [B, '10000000-0000-4000-8000-000000000001'], { tenantId: B, actorUserId: UB },
    ), { code: '23503' });
  });

  it('enforces document ownership of invoice and block evidence', async () => {
    await assert.rejects(tenantQuery('INSERT INTO public.invoices (tenant_id, source_document_id, source_page_id) VALUES ($1,$2,$3)', [A, D1, P2]), { code: '23503' });
    await assert.rejects(tenantQuery("INSERT INTO public.document_blocks (tenant_id, document_id, page_id, block_number, block_type) VALUES ($1,$2,$3,2,'text')", [A, D1, P2]), { code: '23503' });
  });

  it('rejects inconsistent page/block evidence within the same document', async () => {
    await assert.rejects(withTenantTransaction(runtime, context, async (client) => {
      const page = (await client.query('INSERT INTO public.document_pages (tenant_id, document_id, page_number) VALUES ($1,$2,2) RETURNING id', [A, D1])).rows[0].id;
      const block = (await client.query("INSERT INTO public.document_blocks (tenant_id, document_id, page_id, block_number, block_type) VALUES ($1,$2,$3,1,'text') RETURNING id", [A, D1, page])).rows[0].id;
      await client.query('INSERT INTO public.invoices (tenant_id, source_document_id, source_page_id, source_block_id) VALUES ($1,$2,$3,$4)', [A, D1, P1, block]);
    }), { code: '23503' });
  });

  it('permits legitimate repeated invoices and repeated document hashes/object references', async () => {
    await rollbackScope(async (client) => {
      for (let index = 0; index < 2; index++) {
        await client.query("INSERT INTO public.invoices (tenant_id, source_document_id, invoice_number, supplier_name, total, currency) VALUES ($1,$2,'DEMO-001','Sample supplier',110,'USD')", [A, D1]);
        await client.query("INSERT INTO public.documents (tenant_id, original_filename, mime_type, file_size_bytes, sha256, object_storage_key) VALUES ($1,'repeat.pdf','application/pdf',100,repeat('a',64),'same-object')", [A]);
      }
      assert.equal((await client.query("SELECT id FROM public.invoices WHERE invoice_number = 'DEMO-001'")).rowCount, 4);
      assert.equal((await client.query("SELECT id FROM public.documents WHERE object_storage_key = 'same-object'")).rowCount, 2);
    });
  });

  it('preserves missing invoice fields as NULL', async () => {
    await rollbackScope(async (client) => {
      const invoice = (await client.query('INSERT INTO public.invoices (tenant_id, source_document_id) VALUES ($1,$2) RETURNING invoice_number, invoice_date, supplier_name, customer_name, subtotal, tax, total, currency', [A, D1])).rows[0];
      assert.ok(Object.values(invoice).every((value) => value === null));
    });
  });

  it('stores exact decimal values and permits signed credit amounts without doing financial calculations', async () => {
    await rollbackScope(async (client) => {
      const value = '9007199254740993.12345678';
      const row = (await client.query("INSERT INTO public.invoices (tenant_id, source_document_id, subtotal, total) VALUES ($1,$2,-10,$3) RETURNING subtotal::text, total::text, original_values->>'total' AS original_total", [A, D1, value])).rows[0];
      assert.equal(row.total, value);
      assert.equal(row.original_total, value);
      assert.equal(row.subtotal, '-10.00000000');
    });
  });

  it('rejects NaN monetary values and malformed SHA-256 values', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.invoices (tenant_id, source_document_id, total) VALUES ($1,$2,'NaN')", [A, D1]), { code: '23514' });
    await assert.rejects(tenantQuery("INSERT INTO public.documents (tenant_id, original_filename, mime_type, file_size_bytes, sha256, object_storage_key) VALUES ($1,'bad.pdf','application/pdf',1,'bad-hash','bad')", [A]), { code: '23514' });
  });

  it('preserves worksheet/cell/table evidence and versioned source pages', async () => {
    const evidence = (await tenantQuery('SELECT worksheet_name, cell_range, table_data FROM public.document_blocks WHERE document_id=$1', [D2])).rows[0];
    assert.equal(evidence.worksheet_name, 'Invoices');
    assert.equal(evidence.cell_range, 'A1:C2');
    assert.equal(evidence.table_data.rows[0][2], '115');
    await rollbackScope(async (client) => {
      await client.query('INSERT INTO public.document_pages (tenant_id, document_id, page_number, source_version) VALUES ($1,$2,1,2)', [A, D1]);
      assert.equal((await client.query('SELECT id FROM public.document_pages WHERE document_id=$1 AND page_number=1', [D1])).rowCount, 2);
    });
  });

  it('rejects invalid bounding boxes and OCR confidence ranges', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.document_blocks (tenant_id, document_id, page_id, block_number, block_type, bounding_box, coordinate_system) VALUES ($1,$2,$3,9,'text',ARRAY[50,0,10,20]::float8[],'pdf_points')", [A, D1, P1]), { code: '23514' });
    await assert.rejects(tenantQuery("INSERT INTO public.document_pages (tenant_id, document_id, page_number, ocr_confidence) VALUES ($1,$2,9,1.1)", [A, D1]), { code: '23514' });
  });

  it('makes page/block source evidence immutable to runtime clients', async () => {
    await assert.rejects(tenantQuery("UPDATE public.document_pages SET extracted_text = 'overwritten' WHERE id = $1", [P1]), { code: '42501' });
    await assert.rejects(tenantQuery('DELETE FROM public.document_blocks WHERE document_id = $1', [D1]), { code: '42501' });
  });

  it('records invoice corrections with immutable originals, actor, reason, revision, and before/after values', async () => {
    await rollbackScope(async (client) => {
      const row = (await client.query("UPDATE public.invoices SET total='112.50' WHERE id=$1 RETURNING total::text, original_values->>'total' AS original_total, revision, review_status", [I1])).rows[0];
      assert.equal(row.total, '112.50000000');
      assert.equal(row.original_total, '110.00000000');
      assert.equal(row.revision, 3);
      assert.equal(row.review_status, 'needs_review');
      const event = (await client.query("SELECT actor_user_id, change_reason, before_data->>'total' AS before_total, after_data->>'total' AS after_total FROM public.audit_events WHERE entity_id=$1 AND event_type='manual_correction' ORDER BY created_at DESC LIMIT 1", [I1])).rows[0];
      assert.equal(event.actor_user_id, UA);
      assert.equal(event.change_reason, context.reason);
      assert.equal(event.before_total, '111.00000000');
      assert.equal(event.after_total, '112.50000000');
    });
  });

  it('rejects silent financial edits and attempts to replace original values', async () => {
    await assert.rejects(tenantQuery('UPDATE public.invoices SET total=200 WHERE id=$1', [I1], { tenantId: A, actorUserId: UA }), { code: '23514' });
    await assert.rejects(tenantQuery("UPDATE public.invoices SET original_values='{}' WHERE id=$1", [I1]), { code: '23514' });
  });

  it('validates the actor and rejects a foreign actor even if SQL changes the session setting', async () => {
    await assert.rejects(tenantQuery('SELECT 1', [], { tenantId: A, actorUserId: UB }), /actor must belong/);
    await assert.rejects(withTenantTransaction(runtime, context, async (client) => {
      await client.query("SELECT set_config('app.user_id', $1, true)", [UB]);
      await client.query('UPDATE public.invoices SET total=200 WHERE id=$1', [I1]);
    }), { code: '42501' });
  });

  it('requires an explicit reviewer for approval and audits that decision', async () => {
    await assert.rejects(tenantQuery("UPDATE public.invoices SET review_status='approved' WHERE id=$1", [I1], { tenantId: A }), { code: '23514' });
    await rollbackScope(async (client) => {
      const row = (await client.query("UPDATE public.invoices SET review_status='approved' WHERE id=$1 RETURNING reviewed_by, reviewed_at", [I1])).rows[0];
      assert.equal(row.reviewed_by, UA);
      assert.ok(row.reviewed_at instanceof Date);
      assert.equal((await client.query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND event_type='review_decision'", [I1])).rowCount, 1);
      const corrected = (await client.query('UPDATE public.invoices SET total=113 WHERE id=$1 RETURNING review_status, reviewed_by', [I1])).rows[0];
      assert.equal(corrected.review_status, 'needs_review');
      assert.equal(corrected.reviewed_by, null);
    });
  });

  it('preserves line-item originals and correction history', async () => {
    await rollbackScope(async (client) => {
      const row = (await client.query("UPDATE public.invoice_line_items SET unit_price='51' WHERE id=$1 RETURNING unit_price::text, original_values->>'unit_price' AS original_price, revision", [L1])).rows[0];
      assert.equal(row.unit_price, '51.00000000');
      assert.equal(row.original_price, '50.00000000');
      assert.equal(row.revision, 2);
      assert.equal((await client.query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND event_type='manual_correction'", [L1])).rowCount, 1);
    });
  });

  it('supports optimistic correction updates without accepting a stale revision', async () => {
    await rollbackScope(async (client) => {
      const first = await client.query('UPDATE public.invoices SET total=114 WHERE id=$1 AND revision=2 RETURNING revision', [I1]);
      assert.equal(first.rowCount, 1);
      assert.equal(first.rows[0].revision, 3);
      const stale = await client.query('UPDATE public.invoices SET total=115 WHERE id=$1 AND revision=2 RETURNING revision', [I1]);
      assert.equal(stale.rowCount, 0);
      assert.equal((await client.query('SELECT total::text FROM public.invoices WHERE id=$1', [I1])).rows[0].total, '114.00000000');
    });
  });

  it('tracks issue resolutions and preserves reported expected/actual values', async () => {
    await rollbackScope(async (client) => {
      const issue = (await client.query("UPDATE public.validation_issues SET resolution_status='resolved' WHERE id=$1 RETURNING resolved_by, resolved_at, resolution_note, expected_value, actual_value", [V1])).rows[0];
      assert.equal(issue.resolved_by, UA);
      assert.ok(issue.resolved_at instanceof Date);
      assert.equal(issue.resolution_note, context.reason);
      assert.deepEqual(issue.expected_value, { duplicate: false });
      assert.equal(issue.actual_value.invoice_number, 'DEMO-001');
      assert.equal((await client.query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND event_type='issue_resolution'", [V1])).rowCount, 1);
    });
  });

  it('stores reconciliation resolutions with the same audit guarantees', async () => {
    await rollbackScope(async (client) => {
      const row = (await client.query("UPDATE public.reconciliation_items SET resolution_status='dismissed' WHERE id=$1 RETURNING resolved_by, expected_value, actual_value", [RI1])).rows[0];
      assert.equal(row.resolved_by, UA);
      assert.equal(row.expected_value, '110');
      assert.equal(row.actual_value, '115');
      assert.equal((await client.query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND event_type='issue_resolution'", [RI1])).rowCount, 1);
    });
  });

  it('enforces the reconciliation run document pair', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.reconciliation_items (tenant_id,reconciliation_run_id,left_document_id,right_document_id,match_status) VALUES ($1,$2,$3,$4,'matched')", [A, R1, D2, D1]), { code: '23503' });
  });

  it('protects audit history from forging, updating, deleting, and truncating', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.audit_events (tenant_id,entity_table,entity_id,event_type) VALUES ($1,'invoices',$2,'forged')", [A, I1]), { code: '42501' });
    await assert.rejects(tenantQuery("UPDATE public.audit_events SET event_type='changed'"), { code: '42501' });
    await assert.rejects(tenantQuery('DELETE FROM public.audit_events'), { code: '42501' });
    await assert.rejects(tenantQuery('TRUNCATE public.audit_events'), { code: '42501' });
    await assert.rejects(withTransaction(admin, (client) => client.query("UPDATE public.audit_events SET event_type='changed'")), { code: '23514' });
  });

  it('enforces durable job idempotency within each tenant and bounds attempts', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.processing_jobs (tenant_id,document_id,job_type,pipeline_version,idempotency_key) VALUES ($1,$2,'fixture','v1','development-fixture-a')", [A, D1]), { code: '23505' });
    await assert.rejects(tenantQuery("INSERT INTO public.processing_jobs (tenant_id,document_id,job_type,pipeline_version,idempotency_key,attempts,max_attempts) VALUES ($1,$2,'fixture','v1','bad-attempts',4,3)", [A, D1]), { code: '23514' });
    await rollbackScope(async (client) => {
      await client.query("INSERT INTO public.processing_jobs (tenant_id,document_id,job_type,pipeline_version,idempotency_key) VALUES ($1,$2,'fixture','v1','development-fixture-a')", [B, D3]);
    }, { tenantId: B, actorUserId: UB });
  });

  it('requires valid completion metadata and preserves finalized extraction runs', async () => {
    await assert.rejects(tenantQuery("UPDATE public.extraction_runs SET status='succeeded',finished_at=now() WHERE id=$1", [E1]), { code: '23514' });
    await assert.rejects(withTenantTransaction(runtime, context, async (client) => {
      await client.query("UPDATE public.extraction_runs SET status='succeeded',provider='manual',structured_result='{}',finished_at=now() WHERE id=$1", [E1]);
      await client.query("UPDATE public.extraction_runs SET structured_result='{\"changed\":true}' WHERE id=$1", [E1]);
    }), { code: '23514' });
  });

  it('rolls back business rows and audit events together and clears pooled tenant context', async () => {
    const id = randomUUID();
    await assert.rejects(withTenantTransaction(runtime, context, async (client) => {
      await client.query("INSERT INTO public.invoices (id,tenant_id,source_document_id,invoice_number) VALUES ($1,$2,$3,'ROLLBACK-ME')", [id, A, D1]);
      throw new Error('Intentional rollback');
    }), /Intentional rollback/);
    assert.equal((await tenantQuery('SELECT id FROM public.invoices WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await tenantQuery('SELECT id FROM public.audit_events WHERE entity_id=$1', [id])).rowCount, 0);
    assert.equal((await runtime.query('SELECT id FROM public.documents')).rowCount, 0);
    const actor = (await runtime.query('SELECT public.current_actor_user_id() AS actor')).rows[0].actor;
    assert.equal(actor, null);
  });

  it('rejects malformed tenant context before executing a database operation', async () => {
    await assert.rejects(withTenantTransaction(runtime, { tenantId: 'not-a-uuid' }, async () => undefined));
  });

  it('requires 1024-dimensional nonzero embeddings with explicit model metadata', async () => {
    await assert.rejects(tenantQuery("INSERT INTO public.document_chunks (tenant_id,document_id,chunk_number,chunk_text,embedding) VALUES ($1,$2,200,'test','[1,0]'::vector)", [A, D1]), { code: '22000' });
    const zero = '[' + Array(1024).fill(0).join(',') + ']';
    await assert.rejects(tenantQuery("INSERT INTO public.document_chunks (tenant_id,document_id,chunk_number,chunk_text,embedding,embedding_model_id,embedding_model_version,embedded_at) VALUES ($1,$2,201,'test',$3::vector,'synthetic','test-v1',now())", [A, D1, zero]), { code: '23514' });
    const vector = '[' + [1, ...Array(1023).fill(0)].join(',') + ']';
    await assert.rejects(tenantQuery("INSERT INTO public.document_chunks (tenant_id,document_id,chunk_number,chunk_text,embedding,embedded_at) VALUES ($1,$2,202,'test',$3::vector,now())", [A, D1, vector]), { code: '23514' });
  });

  it('uses the cosine HNSW index and returns the closest synthetic vectors', async () => {
    await rollbackScope(async (client) => {
      const first = '[' + [1, ...Array(1023).fill(0)].join(',') + ']';
      const second = '[' + [0, 1, ...Array(1022).fill(0)].join(',') + ']';
      for (const [index, vector] of [first, second].entries()) {
        await client.query("INSERT INTO public.document_chunks (tenant_id,document_id,chunk_number,chunk_text,embedding,embedding_model_id,embedding_model_version,embedded_at,embedding_configuration) VALUES ($1,$2,$3,'Synthetic vector test only',$4::vector,'test/synthetic-unit-vector','test-v1',now(),'{\"synthetic_test\":true}')", [A, D1, 1000 + index, vector]);
      }
      await client.query('SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_sort=off');
      const sql = "SELECT chunk_number, embedding <=> $1::vector AS distance FROM public.document_chunks WHERE embedding IS NOT NULL AND embedding_model_id='test/synthetic-unit-vector' AND embedding_model_version='test-v1' ORDER BY embedding <=> $1::vector LIMIT 2";
      const plan = await client.query('EXPLAIN (FORMAT JSON) ' + sql, [first]);
      assert.match(JSON.stringify(plan.rows), /document_chunks_embedding_hnsw_idx/);
      const nearest = (await client.query(sql, [first])).rows;
      assert.deepEqual(nearest.map((row) => row.chunk_number), [1000, 1001]);
      assert.deepEqual(nearest.map((row) => Number(row.distance)), [0, 1]);
    });
  });

  it('indexes keyword-search text and preserves tenant isolation in search', async () => {
    const sql = "SELECT id FROM public.document_chunks WHERE search_vector @@ plainto_tsquery('simple', 'supplier')";
    assert.equal((await tenantQuery(sql)).rowCount, 1);
    assert.equal((await tenantQuery(sql, [], { tenantId: B, actorUserId: UB })).rowCount, 0);
    const index = await admin.query("SELECT indexdef FROM pg_indexes WHERE indexname='document_chunks_embedding_hnsw_idx'");
    assert.match(index.rows[0].indexdef, /USING hnsw.*vector_cosine_ops/);
  });

  it('defaults to confidential and requires an actor for cloud-policy changes', async () => {
    assert.equal((await tenantQuery('SELECT data_classification FROM public.documents WHERE id=$1',[D1])).rows[0].data_classification,'confidential');
    await assert.rejects(rollbackScope((client) => client.query("UPDATE public.documents SET data_classification='public' WHERE id=$1",[D1]), { tenantId:A,reason:'Missing administrator actor' }), {code:'23514'});
  });

  it('stamps administrator policy decisions and clears approval stamps on revocation', async () => {
    await rollbackScope(async (client) => {
      const approved = (await client.query("UPDATE public.documents SET data_classification='synthetic',cloud_processing_allowed=true WHERE id=$1 RETURNING *",[D1])).rows[0];
      assert.equal(approved.data_classified_by,UA); assert.equal(approved.cloud_approved_by,UA); assert.ok(approved.cloud_approved_at);
      const revoked = (await client.query('UPDATE public.documents SET cloud_processing_allowed=false WHERE id=$1 RETURNING *',[D1])).rows[0];
      assert.equal(revoked.cloud_approved_by,null); assert.equal(revoked.cloud_approved_at,null);
      assert.equal((await client.query('SELECT id FROM public.audit_events WHERE entity_id=$1 AND actor_user_id=$2',[D1,UA])).rowCount! > 0,true);
    });
  });

  it('isolates provider attempts and health records by tenant', async () => {
    await rollbackScope(async (client) => {
      const fixture = await extractionAttemptFixture(client);
      await client.query("INSERT INTO public.llm_provider_health (tenant_id,provider,model_id,endpoint_fingerprint) VALUES ($1,'local_qwen','qwen-fixture',repeat('b',64))",[A]);
      assert.equal((await client.query('SELECT id FROM public.extraction_attempts WHERE id=$1',[fixture.attemptId])).rowCount,1);
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[B]);
      assert.equal((await client.query('SELECT id FROM public.extraction_attempts')).rowCount,0);
      assert.equal((await client.query('SELECT id FROM public.llm_provider_health')).rowCount,0);
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[A]);
    });
  });

  it('enforces attempt identity, finalization and composite document references', async () => {
    await assert.rejects(rollbackScope(async (client) => {
      const fixture = await extractionAttemptFixture(client);
      await client.query("UPDATE public.extraction_attempts SET status='failed',finished_at=clock_timestamp(),error_code='FIXTURE_FAILURE' WHERE id=$1",[fixture.attemptId]);
      await client.query("UPDATE public.extraction_attempts SET model_id='forged' WHERE id=$1",[fixture.attemptId]);
    }),{code:'23514'});
    await assert.rejects(rollbackScope(async (client) => {
      const fixture = await extractionAttemptFixture(client);
      await client.query("INSERT INTO public.extraction_attempts (tenant_id,document_id,extraction_run_id,provider,model_id,prompt_version,attempt_number,fallback_used,status,input_sha256,policy_snapshot) VALUES ($1,$2,$3,'gemini','gemini-fixture','invoice-extraction-v1',1,false,'running',repeat('c',64),'{}')",[A,D2,fixture.extractionRunId]);
    }),{code:'23503'});
  });

  it('rolls back extraction snapshots, attempt logs and audit history atomically', async () => {
    const original = await counts(); await rollbackScope(extractionAttemptFixture); assert.deepEqual(await counts(),original);
  });

  it('reapplies seeds and migration commands without adding rows or audit noise', async () => {
    const original = await counts();
    assert.ok(Object.entries(original).filter(([table]) => !['document_understanding_runs', 'invoice_candidates', 'extraction_attempts', 'llm_provider_health','financial_validation_runs','indexing_runs'].includes(table)).every(([, count]) => count > 0));
    assert.equal(original.document_understanding_runs, 0);
    assert.equal(original.invoice_candidates, 0);
    await seedDevelopmentDatabase(admin, 'test');
    assert.deepEqual(await counts(), original);
    assert.equal((await runMigrations(admin)).length, 0);
    assert.ok((await migrationStatus(admin)).every((migration) => migration.status === 'applied'));
    await assert.rejects(seedDevelopmentDatabase(admin, 'production'), /disabled/);
  });

  it('rolls back a failing migration atomically without recording it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'document-schema-migration-'));
    try {
      await cp(migrationsDirectory, directory, { recursive: true });
      await writeFile(join(directory, '9999_intentional_failure.sql'), '-- Up Migration\nCREATE TABLE public.must_rollback (id uuid);\nSELECT 1/0;\n-- Down Migration\nDROP TABLE public.must_rollback;\n');
      await assert.rejects(runMigrations(admin, { directory }), { code: '22012' });
      assert.equal((await admin.query("SELECT to_regclass('public.must_rollback') AS name")).rows[0].name, null);
      assert.equal((await admin.query('SELECT name FROM public.pgmigrations')).rowCount, migrationCount);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects concurrent migration runners using the advisory lock', async () => {
    const client = await admin.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', ['7241865325823964']);
      await assert.rejects(runMigrations(admin), /migration.*running|lock/i);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', ['7241865325823964']);
      client.release();
    }
  });

  it('can dry-run the latest rollback without changing schema or migration history', async () => {
    const before = (await admin.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname")).rows;
    await runMigrations(admin, { direction: 'down', count: 1, dryRun: true });
    const after = (await admin.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname")).rows;
    assert.deepEqual(after, before);
    assert.equal((await admin.query('SELECT name FROM public.pgmigrations')).rowCount, migrationCount);
  });

  it('downgrades extraction safely by cancelling pending jobs and runs while preserving source evidence', async () => {
    let jobId = '', runId = '';
    const pagesBefore = (await admin.query('SELECT id FROM public.document_pages ORDER BY id')).rows;
    await withTenantTransaction(runtime, context, async (client) => {
      const fixture = await understandingFixture(client);
      await client.query("UPDATE public.documents SET metadata=jsonb_set(metadata,'{understanding}',$2) WHERE id=$1", [D1,JSON.stringify({runId:fixture.runId})]);
      const jobs = await enqueueInvoiceExtractions(client,{tenantId:A,documentId:D1,configured:true,requestKey:'rollback-fixture',maxDispatchFailures:2});
      jobId = jobs[0]!.id; runId = randomUUID();
      await client.query("INSERT INTO public.extraction_runs (id,tenant_id,document_id,processing_job_id,candidate_id,understanding_run_id) VALUES ($1,$2,$3,$4,$5,$6)",[runId,A,D1,jobId,fixture.candidateId,fixture.runId]);
    });
    await runMigrations(admin,{direction:'down',count:migrationCount-6});
    assert.equal((await admin.query('SELECT status FROM public.processing_jobs WHERE id=$1',[jobId])).rows[0].status,'cancelled');
    assert.equal((await admin.query('SELECT status FROM public.extraction_runs WHERE id=$1',[runId])).rows[0].status,'cancelled');
    assert.deepEqual((await admin.query('SELECT id FROM public.document_pages ORDER BY id')).rows,pagesBefore);
    assert.equal((await admin.query("SELECT to_regclass('public.extraction_attempts') AS name")).rows[0].name,null);
    assert.equal((await runMigrations(admin)).length,migrationCount-6);
    assert.equal((await admin.query('SELECT status FROM public.processing_jobs WHERE id=$1',[jobId])).rows[0].status,'cancelled');
  });

  it('rolls back the understanding migration without stale active pointers or lost source pages', async () => {
    const pagesBefore = Number((await admin.query('SELECT count(*) AS count FROM public.document_pages')).rows[0].count);
    await withTenantTransaction(runtime, context, async (client) => {
      const fixture = await understandingFixture(client);
      await client.query("UPDATE public.documents SET document_type='invoice',metadata=jsonb_set(metadata,'{understanding}',$2) WHERE id=$1", [D1, JSON.stringify({ runId: fixture.runId })]);
    });
    await runMigrations(admin, { direction: 'down', count: migrationCount - 5 });
    assert.equal((await admin.query("SELECT metadata ? 'understanding' AS active FROM public.documents WHERE id=$1", [D1])).rows[0].active, false);
    assert.equal(Number((await admin.query('SELECT count(*) AS count FROM public.document_pages')).rows[0].count), pagesBefore);
    assert.equal((await runMigrations(admin)).length, migrationCount - 5);
    assert.equal((await admin.query('SELECT id FROM public.invoice_candidates')).rowCount, 0);
  });

  it('supports a complete down/up round trip while retaining the shared vector extension', async () => {
    await runMigrations(admin, { direction: 'down', count: migrationCount });
    assert.equal((await admin.query('SELECT name FROM public.pgmigrations')).rowCount, 0);
    for (const table of tables) assert.equal((await admin.query('SELECT to_regclass($1) AS name', ['public.' + table])).rows[0].name, null);
    assert.equal((await admin.query("SELECT extname FROM pg_extension WHERE extname='vector'")).rowCount, 1);
    assert.equal((await runMigrations(admin)).length, migrationCount);
    await seedDevelopmentDatabase(admin, 'test');
    assert.equal((await tenantQuery('SELECT id FROM public.documents')).rowCount, 2);
  });
});
