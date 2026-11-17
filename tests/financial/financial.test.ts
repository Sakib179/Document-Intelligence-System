import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { loadEnvironment } from '@doc/core';
import { createDatabasePool, withTenantTransaction } from '@doc/database';
import { createMigrationPool, runMigrations, provisionApplicationRole, provisionDispatcherRole, seedDevelopmentDatabase, migrationStatus } from '@doc/database/admin';
import { buildApi } from '../fixtures/workspace-api.js';
import { selectWorkspace } from '../fixtures/workspace-api.js';
import { invoiceFixture } from '../fixtures/finance.js';
import { validationRunSchema, reconciliationRunSchema } from '@doc/contracts';
const environment = loadEnvironment(), cluster = createMigrationPool(environment), databaseName = 'di_financial_test_' + randomUUID().replaceAll('-', '');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', UA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', UB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', READER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const context = { tenantId: A, actorUserId: UA, reason: 'Controlled financial integration fixture' };
let database: ReturnType<typeof createDatabasePool>, admin: ReturnType<typeof createMigrationPool>, api: ReturnType<typeof buildApi>, workspace: string, otherWorkspace: string, readerWorkspace: string, created = false;
const query = (sql: string, values: unknown[] = []) => withTenantTransaction(database, context, client => client.query(sql, values));
const authorization = () => ({ 'x-test-workspace':  workspace });
let primary: {
  documentId: string;
  invoiceIds: string[];
};
/** Explicit synthetic normalized/extracted database fixtures, without invoking or claiming model inference. */
async function documentFixture(options: {
  mime?: string;
  hash?: string;
  records?: {
    number?: string;
    total?: string;
    supplier?: string;
    description?: string;
  }[];
  active?: boolean;
} = {}) {
  const documentId = randomUUID(), jobId = randomUUID(), runId = randomUUID(), pageId = randomUUID(), records = options.records ?? [{}], mime = options.mime ?? 'application/pdf', spreadsheet = mime !== 'application/pdf';
  const invoiceIds: string[] = [];
  await withTenantTransaction(database, context, async (client) => {
    await client.query("INSERT INTO public.documents (id,tenant_id,original_filename,mime_type,file_size_bytes,sha256,object_storage_key,processing_status,page_count,document_type,metadata) VALUES ($1,$2,'controlled-financial-fixture',$3,100,$4,$5,'processed',1,'invoice',$6)", [documentId, A, mime, options.hash ?? createHash('sha256').update(documentId).digest('hex'), 'development/fixtures/not-uploaded/' + documentId, JSON.stringify({ development_fixture: true, object_exists: false, ...(options.active === false ? {} : { understanding: { runId } }) })]);
    await client.query("INSERT INTO public.processing_jobs (id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,checkpoint) VALUES ($1,$2,$3,'financial_test_fixture','not-executed',$4,'{\"development_fixture\":true,\"not_dispatched\":true}')", [jobId, A, documentId, jobId]);
    await client.query("INSERT INTO public.document_understanding_runs (id,tenant_id,document_id,processing_job_id,source_version,manifest_key,algorithm_version,document_type,segmentation_confidence,requires_manual_review,candidate_count,invoice_candidate_count,ai_status) VALUES ($1,$2,$3,$4,1,'development-fixture/not-executed','segmentation-v1','invoice',1,false,$5,$5,'disabled')", [runId, A, documentId, jobId, records.length]);
    await client.query("INSERT INTO public.document_pages (id,tenant_id,document_id,page_number,source_kind,extracted_text,extraction_method,worksheet_name,source_reference) VALUES ($1,$2,$3,1,$4,'Controlled synthetic invoice ground truth',$5,$6,'{\"development_fixture\":true}')", [pageId, A, documentId, spreadsheet ? 'worksheet' : 'pdf_page', spreadsheet ? 'spreadsheet' : 'digital', spreadsheet ? 'Invoice ledger' : null]);
    for (const [ordinal, record] of records.entries()) {
      const candidateId = randomUUID(), invoice = invoiceFixture(), id = randomUUID();
      const data = { candidate_id: candidateId, document_id: documentId, document_type: 'invoice', source_pages: [1], source_worksheets: spreadsheet ? ['Invoice ledger'] : [], source_locations: [{ page_number: 1, source_kind: spreadsheet ? 'worksheet_row' : 'pdf_page', worksheet_name: spreadsheet ? 'Invoice ledger' : null, row_start: spreadsheet ? ordinal + 2 : null, row_end: spreadsheet ? ordinal + 2 : null, cell_range: spreadsheet ? 'A' + (ordinal + 2) + ':H' + (ordinal + 2) : null, artifact: 'development-fixture/not-executed', artifact_line: 1, end_artifact: 'development-fixture/not-executed', end_artifact_line: 1 }], segmentation_confidence: 1, requires_manual_review: false, review_reasons: [], evidence: [], advisor_suggestion: null };
      await client.query("INSERT INTO public.invoice_candidates (id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) VALUES ($1,$2,$3,$4,$5,'invoice',1,false,$6)", [candidateId, A, documentId, runId, ordinal + 1, JSON.stringify(data)]);
      const evidence = spreadsheet ? { worksheet: 'Invoice ledger', cell: 'G' + (ordinal + 2), text: record.total ?? '115.00' } : { page: 1, text: 'Invoice ' + (record.number ?? 'FIN-701') + ' Total ' + (record.total ?? '115.00') };
      await client.query("INSERT INTO public.invoices (id,tenant_id,source_document_id,source_page_id,source_candidate_id,invoice_number,invoice_date,supplier_name,customer_name,subtotal,tax,total,currency,field_evidence,financial_terms,extraction_metadata,review_status) VALUES ($1,$2,$3,$4,$5,$6,'2026-11-15',$7,'Example Buyer','100','15',$8,'USD',$9,$10,'{\"development_fixture\":true,\"model_not_executed\":true}','needs_review')", [id, A, documentId, pageId, candidateId, record.number ?? 'FIN-701', record.supplier ?? 'Finance Supplier Ltd', record.total ?? '115.00', JSON.stringify(evidence), JSON.stringify(invoice.terms)]);
      const line = invoice.line_items[0]!;
      await client.query('INSERT INTO public.invoice_line_items (tenant_id,invoice_id,source_document_id,line_number,description,quantity,unit_price,tax_rate,line_total,source_evidence) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9)', [A, id, documentId, record.description ?? line.description, line.quantity, line.unit_price, line.tax_rate, line.line_total, JSON.stringify(spreadsheet ? { worksheet: 'Invoice ledger', cell: 'I' + (ordinal + 2), text: 'Widget 2 50.00 0.15 100.00' } : line.evidence)]);
      invoiceIds.push(id);
    }
  });
  return { documentId, invoiceIds };
}
async function validate(id: string, key = randomUUID(), rules: Record<string, unknown> = {}) {
  return api.inject({ method: 'POST', url: `/v1/invoices/${id}/validations`, headers: { ...authorization(), 'idempotency-key': key }, payload: { rules } });
}
async function reconcile(left: string, right: string, key = randomUUID()) {
  return api.inject({ method: 'POST', url: '/v1/reconciliations', headers: { ...authorization(), 'idempotency-key': key }, payload: { left_document_id: left, right_document_id: right } });
}
describe('financial validation and reconciliation with real PostgreSQL and configured-workspace REST', { concurrency: false }, () => {
  before(async () => {
    await provisionApplicationRole(cluster, environment.POSTGRES_APP_PASSWORD);
    await provisionDispatcherRole(cluster, environment.POSTGRES_DISPATCHER_PASSWORD);
    await cluster.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
    created = true;
    const config = { ...environment, POSTGRES_DB: databaseName, LOG_LEVEL: 'silent' as const };
    admin = createMigrationPool(config);
    database = createDatabasePool(config);
    await runMigrations(admin);
    await seedDevelopmentDatabase(admin, 'test');
    await admin.query("INSERT INTO public.users(id,tenant_id,email,display_name,role) VALUES ($1,$2,'financial-reader@example.invalid','Financial reader','reader')", [READER, A]);
    api = buildApi(config);
    await api.ready();
    workspace = await selectWorkspace(config, { tenantId: A, userId: UA });
    otherWorkspace = await selectWorkspace(config, { tenantId: B, userId: UB });
    readerWorkspace = await selectWorkspace(config, { tenantId: A, userId: READER });
    primary = await documentFixture();
  });
  after(async () => {
    if (api)
      await api.close();
    if (database)
      await database.end();
    if (admin)
      await admin.end();
    try {
      if (created)
        await cluster.query('DROP DATABASE "' + databaseName + '" WITH (FORCE)');
    }
    finally {
      await cluster.end();
    }
  });
  it('validates exact source snapshots and keeps processing and manual review states separate', async () => {
    const id = primary.invoiceIds[0]!, response = await validate(id);
    assert.equal(response.statusCode, 201, response.body);
    const run = validationRunSchema.parse(response.json().run);
    assert.equal(run.status, 'VALID');
    assert.equal(run.is_current, true);
    assert.equal(run.snapshot.invoice.total, '115.00000000');
    assert.equal(run.snapshot.invoice.original_values.total, '115.00000000');
    assert.equal((await query('SELECT processing_status FROM public.documents WHERE id=$1', [primary.documentId])).rows[0].processing_status, 'processed');
    assert.equal((await query('SELECT review_status FROM public.invoices WHERE id=$1', [id])).rows[0].review_status, 'needs_review');
    assert.ok((await query("SELECT id FROM public.audit_events WHERE entity_table='financial_validation_runs' AND entity_id=$1", [run.id])).rowCount! > 0);
  });
  it('makes simultaneous same-key validation requests idempotent and rejects changed rules', async () => {
    const id = primary.invoiceIds[0]!, key = randomUUID(), responses = await Promise.all([validate(id, key), validate(id, key), validate(id, key)]);
    for (const response of responses)
      assert.ok([200, 201].includes(response.statusCode), response.body);
    assert.equal(new Set(responses.map(response => response.json().run.id)).size, 1);
    assert.equal((await query('SELECT id FROM public.financial_validation_runs WHERE invoice_id=$1 AND request_key=$2', [id, key])).rowCount, 1);
    assert.equal((await validate(id, key, { tolerance_minor_units: '0' })).statusCode, 409);
  });
  it('enforces authentication, reader permissions, tenant isolation and strict inputs', async () => {
    const id = primary.invoiceIds[0]!, url = `/v1/invoices/${id}/validations`;
    assert.equal((await api.inject(url)).statusCode, 200);
    assert.equal((await api.inject({ url, headers: { 'x-test-workspace':  otherWorkspace } })).statusCode, 404);
    assert.equal((await api.inject({ method: 'POST', url, headers: { 'x-test-workspace':  readerWorkspace }, payload: {} })).statusCode, 403);
    assert.equal((await api.inject({ url, headers: { 'x-test-workspace':  readerWorkspace } })).statusCode, 200);
    assert.equal((await validate(id, randomUUID(), { not_a_rule: true })).statusCode, 400);
    assert.equal((await api.inject({ url: url + '?limit=1000', headers: authorization() })).statusCode, 400);
    assert.equal((await api.inject({ url: '/v1/invoices/not-a-uuid/validations', headers: authorization() })).statusCode, 400);
    const scoped = await withTenantTransaction(database, { tenantId: B, actorUserId: UB }, client => client.query('SELECT id FROM public.financial_validation_runs'));
    assert.equal(scoped.rowCount, 0);
    assert.equal((await database.query('SELECT id FROM public.financial_validation_runs')).rowCount, 0);
  });
  it('audits term corrections, preserves unrelated terms and invalidates earlier validation snapshots', async () => {
    const id = primary.invoiceIds[0]!, before = (await query('SELECT revision FROM public.invoices WHERE id=$1', [id])).rows[0], url = `/v1/invoices/${id}/financial-terms`;
    const response = await api.inject({ method: 'PATCH', url, headers: authorization(), payload: { revision: before.revision, reason: 'Correct printed charge from page 1', terms: { charges: '5' } } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().terms.tax_mode, 'exclusive');
    assert.equal(response.json().terms.discounts, '0');
    const history = await api.inject({ url: `/v1/invoices/${id}/validations`, headers: authorization() });
    assert.equal(history.json().stale, true);
    assert.equal(history.json().financial_status, 'REVIEW_REQUIRED');
    assert.equal((await api.inject({ method: 'PATCH', url, headers: authorization(), payload: { revision: before.revision, reason: 'Stale reviewer change', terms: { charges: '0' } } })).statusCode, 409);
    const audit = (await query("SELECT before_data,after_data FROM public.audit_events WHERE entity_table='invoices' AND entity_id=$1 AND event_type='manual_correction' ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
    assert.equal(audit.before_data.financial_terms.charges, '0');
    assert.equal(audit.after_data.financial_terms.charges, '5');
    assert.equal((await validate(id)).json().run.result.issues.some((issue: any) => issue.code === 'TOTAL_MISMATCH'), true);
    await query("UPDATE public.invoices SET financial_terms=jsonb_set(financial_terms,'{charges}','\"0\"') WHERE id=$1", [id]);
  });
  it('detects invalid numeric terms without coercing or executing their contents', async () => {
    const fixture = await documentFixture({ records: [{ number: 'FIN-NUMERIC' }] }), id = fixture.invoiceIds[0]!;
    await query("UPDATE public.invoices SET financial_terms=jsonb_set(financial_terms,'{charges}','\"1e3\"') WHERE id=$1", [id]);
    const response = await validate(id);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().run.result.issues.some((issue: any) => issue.code === 'INVALID_NUMERIC_STRING' && issue.field === 'terms.charges'), true);
    assert.equal((await query('SELECT total::text FROM public.invoices WHERE id=$1', [id])).rows[0].total, '115.00000000');
  });
  it('persists immutable calculation issues but allows audited manual resolution', async () => {
    const fixture = await documentFixture({ records: [{ number: 'FIN-MISMATCH', total: '120.00' }] }), id = fixture.invoiceIds[0]!, response = await validate(id), run = response.json().run;
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(run.status, 'REVIEW_REQUIRED');
    const issue = (await query("SELECT * FROM public.validation_issues WHERE financial_validation_run_id=$1 AND issue_code='TOTAL_MISMATCH'", [run.id])).rows[0];
    assert.equal(issue.expected_value, '115.00');
    assert.equal(issue.actual_value, '120');
    assert.equal(issue.financial_severity, 'high');
    assert.equal(issue.manual_review_required, true);
    await assert.rejects(query("UPDATE public.validation_issues SET expected_value='\"forged\"' WHERE id=$1", [issue.id]), { code: '23514' });
    await assert.rejects(query("UPDATE public.financial_validation_runs SET financial_status='VALID' WHERE id=$1", [run.id]), { code: '42501' });
    await query("UPDATE public.validation_issues SET resolution_status='dismissed',resolution_note='Reviewer retains source discrepancy as explained' WHERE id=$1", [issue.id]);
    assert.ok((await query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND event_type='issue_resolution'", [issue.id])).rowCount! > 0);
    const history = await api.inject({ url: `/v1/invoices/${id}/validations`, headers: authorization() });
    assert.equal(history.json().runs[0].result.status, 'REVIEW_REQUIRED');
  });
  it('rolls back run, issues and audit events atomically when issue publication fails', async () => {
    const fixture = await documentFixture({ records: [{ number: 'FIN-ROLLBACK', total: '120' }] }), id = fixture.invoiceIds[0]!;
    const before = (await query("SELECT count(*)::integer AS count FROM public.audit_events WHERE entity_table='financial_validation_runs'")).rows[0].count;
    await admin.query("CREATE FUNCTION public.fail_finance_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled issue persistence failure'; END $$");
    await admin.query('CREATE TRIGGER fail_finance_fixture BEFORE INSERT ON public.validation_issues FOR EACH ROW EXECUTE FUNCTION public.fail_finance_fixture()');
    try {
      assert.equal((await validate(id)).statusCode, 500);
    }
    finally {
      await admin.query('DROP TRIGGER fail_finance_fixture ON public.validation_issues');
      await admin.query('DROP FUNCTION public.fail_finance_fixture()');
    }
    assert.equal((await query('SELECT id FROM public.financial_validation_runs WHERE invoice_id=$1', [id])).rowCount, 0);
    assert.equal((await query("SELECT count(*)::integer AS count FROM public.audit_events WHERE entity_table='financial_validation_runs'")).rows[0].count, before);
  });
  it('flags exact and business duplicates without rejecting or overwriting either invoice', async () => {
    const hash = (await query('SELECT sha256 FROM public.documents WHERE id=$1', [primary.documentId])).rows[0].sha256;
    const duplicate = await documentFixture({ hash }), response = await validate(duplicate.invoiceIds[0]!);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().run.result.issues.some((issue: any) => issue.code === 'EXACT_FILE_DUPLICATE' && issue.related_document_id === primary.documentId), true);
    assert.equal(response.json().run.result.issues.some((issue: any) => issue.code === 'BUSINESS_DUPLICATE_CANDIDATE'), true);
    assert.equal((await query('SELECT processing_status FROM public.documents WHERE id=$1', [duplicate.documentId])).rows[0].processing_status, 'processed');
    assert.equal((await query('SELECT id FROM public.invoices WHERE id=ANY($1::uuid[])', [[primary.invoiceIds[0], duplicate.invoiceIds[0]]])).rowCount, 2);
    const previous = await api.inject({ url: `/v1/invoices/${primary.invoiceIds[0]}/validations`, headers: authorization() });
    assert.equal(previous.json().stale, true);
  });
  it('invalidates financial status after a line correction while retaining original line values', async () => {
    const fixture = await documentFixture({ records: [{ number: 'FIN-LINE-HISTORY', supplier: 'Unique line-history supplier' }] }), id = fixture.invoiceIds[0]!, response = await validate(id);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().run.status, 'VALID');
    await query("UPDATE public.invoice_line_items SET quantity='3' WHERE invoice_id=$1", [id]);
    const history = await api.inject({ url: `/v1/invoices/${id}/validations`, headers: authorization() });
    assert.equal(history.json().financial_status, 'REVIEW_REQUIRED');
    assert.equal(history.json().runs[0].snapshot.invoice.line_items[0].quantity, '2.00000000');
    const next = await validate(id);
    assert.equal(next.statusCode, 201, next.body);
    assert.equal(next.json().run.result.issues.some((issue: any) => issue.code === 'LINE_AMOUNT_MISMATCH'), true);
    assert.equal(next.json().run.snapshot.invoice.line_items[0].original_values.quantity, '2.00000000');
  });
  it('reconciles PDFs with exact original snapshots and keeps processing completion separate from financial mismatch', async () => {
    const left = await documentFixture({ records: [{ number: 'RECON-100' }] }), right = await documentFixture({ records: [{ number: 'RECON-100', total: '120' }] }), response = await reconcile(left.documentId, right.documentId);
    assert.equal(response.statusCode, 201, response.body);
    const run = reconciliationRunSchema.parse(response.json().run);
    assert.equal(run.processing_status, 'succeeded');
    assert.equal(run.financial_status, 'REVIEW_REQUIRED');
    assert.equal(run.is_current, true);
    const difference = run.result.comparisons.find(item => item.field === 'total')!;
    assert.equal(difference.expected, '115.00000000');
    assert.equal(difference.actual, '120.00000000');
    assert.ok(difference.evidence.left);
    assert.equal((await query("SELECT id FROM public.reconciliation_items WHERE reconciliation_run_id=$1 AND field_path='total' AND match_status='mismatch'", [run.id])).rowCount, 1);
    const persisted = (await query('SELECT * FROM public.reconciliation_items WHERE reconciliation_run_id=$1 LIMIT 1', [run.id])).rows[0];
    await assert.rejects(query("UPDATE public.reconciliation_items SET field_path='forged' WHERE id=$1", [persisted.id]), { code: '23514' });
    await assert.rejects(query("UPDATE public.reconciliation_runs SET financial_status='VALID' WHERE id=$1", [run.id]), { code: '23514' });
    const read = await api.inject({ url: '/v1/reconciliations/' + run.id, headers: authorization() });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal((await api.inject({ url: '/v1/reconciliations/' + run.id, headers: { 'x-test-workspace':  otherWorkspace } })).statusCode, 404);
  });
  for (const mime of ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'])
    it('reconciles PDF with ' + mime + ' and retains worksheet/cell evidence', async () => {
      const left = await documentFixture({ records: [{ number: 'RECON-TABLE' }] }), right = await documentFixture({ mime, records: [{ number: 'RECON-TABLE', total: '120' }] }), response = await reconcile(left.documentId, right.documentId);
      assert.equal(response.statusCode, 201, response.body);
      const run = response.json().run, difference = run.result.comparisons.find((item: any) => item.field === 'total');
      assert.equal(difference.evidence.right.source.worksheet, 'Invoice ledger');
      assert.equal(difference.evidence.right.source.cell, 'G2');
      assert.equal(difference.evidence.right.original_values.total, '120.00000000');
    });
  it('returns VALID only for an unambiguous comparison with complete source coverage', async () => {
    const left = await documentFixture({ records: [{ number: 'RECON-VALID' }] }), right = await documentFixture({ records: [{ number: 'RECON-VALID' }] }), response = await reconcile(left.documentId, right.documentId);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().run.financial_status, 'VALID');
    const incomplete = await documentFixture({ active: false, records: [{ number: 'RECON-VALID' }] }), review = await reconcile(left.documentId, incomplete.documentId);
    assert.equal(review.statusCode, 201, review.body);
    assert.equal(review.json().run.financial_status, 'REVIEW_REQUIRED');
    assert.equal(review.json().run.result.issues.some((issue: any) => issue.code === 'DOCUMENT_COVERAGE_INCOMPLETE'), true);
  });
  it('retains ambiguous invoice boundaries rather than pairing repeated identities arbitrarily', async () => {
    const left = await documentFixture({ records: [{ number: 'RECON-AMBIGUOUS' }] }), right = await documentFixture({ records: [{ number: 'RECON-AMBIGUOUS' }, { number: 'RECON-AMBIGUOUS' }] }), response = await reconcile(left.documentId, right.documentId);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().run.result.pairs[0].match_status, 'ambiguous');
    assert.equal(response.json().run.result.pairs[0].candidate_right_ids.length, 2);
  });
  it('replays reconciliation keys, rejects conflicting payloads and detects later source edits', async () => {
    const left = await documentFixture({ records: [{ number: 'RECON-HISTORY' }] }), right = await documentFixture({ records: [{ number: 'RECON-HISTORY' }] }), key = randomUUID();
    const response = await reconcile(left.documentId, right.documentId, key), id = response.json().run.id;
    assert.equal(response.statusCode, 201, response.body);
    assert.equal((await reconcile(left.documentId, right.documentId, key)).statusCode, 200);
    assert.equal((await reconcile(right.documentId, left.documentId, key)).statusCode, 409);
    await query("UPDATE public.invoice_line_items SET quantity='3' WHERE invoice_id=$1", [right.invoiceIds[0]]);
    const stale = await api.inject({ url: '/v1/reconciliations/' + id, headers: authorization() });
    assert.equal(stale.json().is_current, false);
    assert.equal(stale.json().result.status, 'VALID');
    const next = await reconcile(left.documentId, right.documentId);
    assert.equal(next.statusCode, 201, next.body);
    assert.equal(next.json().run.financial_status, 'REVIEW_REQUIRED');
    assert.notEqual(next.json().run.id, id);
  });
  it('rejects unsupported pairs, self-comparison and unauthorized reconciliation requests', async () => {
    assert.equal((await reconcile(primary.documentId, primary.documentId)).statusCode, 400);
    const image = await documentFixture({ mime: 'image/png' });
    assert.equal((await reconcile(primary.documentId, image.documentId)).statusCode, 400);
    const url = '/v1/reconciliations', payload = { left_document_id: primary.documentId, right_document_id: image.documentId };
    assert.equal((await api.inject({ method: 'POST', url, headers: { 'x-test-workspace':  readerWorkspace }, payload })).statusCode, 403);
    assert.equal((await api.inject({ method: 'POST', url, headers: { 'x-test-workspace':  otherWorkspace }, payload })).statusCode, 404);
    assert.equal((await api.inject({ method: 'POST', url, headers: authorization(), payload: { ...payload, sql: 'DROP TABLE invoices' } })).statusCode, 400);
  });
  it('rejects oversized financial source ranges without publishing a partial report', async () => {
    const fixture = await documentFixture({ records: [{ number: 'FIN-LIMIT-A' }, { number: 'FIN-LIMIT-B' }] });
    for (const id of fixture.invoiceIds)
      await query(`INSERT INTO public.invoice_line_items
      (tenant_id,invoice_id,source_document_id,line_number,description,quantity,unit_price,tax_rate,line_total)
      SELECT $1,$2,$3,n,'Controlled bounded-source fixture','1','1','0','1' FROM generate_series(2,600) n`, [A, id, fixture.documentId]);
    const key = randomUUID(), response = await reconcile(primary.documentId, fixture.documentId, key);
    assert.equal(response.statusCode, 413, response.body);
    assert.equal(response.json().error.code, 'RECONCILIATION_LINE_LIMIT');
    assert.equal((await query('SELECT id FROM public.reconciliation_runs WHERE request_key=$1', [key])).rowCount, 0);
    await query(`INSERT INTO public.invoice_line_items
      (tenant_id,invoice_id,source_document_id,line_number,description,quantity,unit_price,tax_rate,line_total)
      SELECT $1,$2,$3,n,'Controlled bounded-source fixture','1','1','0','1' FROM generate_series(601,1001) n`, [A, fixture.invoiceIds[0], fixture.documentId]);
    assert.equal((await validate(fixture.invoiceIds[0]!)).statusCode, 413);
  });
  it('enforces database report status and source identity independently of HTTP validation', async () => {
    const source = (await query('SELECT id FROM public.financial_validation_runs LIMIT 1')).rows[0];
    await assert.rejects(query(`INSERT INTO public.financial_validation_runs
      (id,tenant_id,document_id,invoice_id,requested_by,request_key,engine_version,input_sha256,financial_status,rules,input_snapshot,result)
      SELECT $1::uuid,tenant_id,document_id,invoice_id,requested_by,$1::uuid::text,engine_version,input_sha256,financial_status,rules,input_snapshot,'{}'::jsonb
      FROM public.financial_validation_runs WHERE id=$2`, [randomUUID(), source.id]), { code: '23514' });
    await assert.rejects(query(`INSERT INTO public.financial_validation_runs
      (id,tenant_id,document_id,invoice_id,requested_by,request_key,engine_version,input_sha256,financial_status,rules,input_snapshot,result)
      SELECT $1::uuid,tenant_id,document_id,invoice_id,requested_by,$1::uuid::text,engine_version,input_sha256,financial_status,rules,
      jsonb_set(input_snapshot,'{invoice,id}',to_jsonb($3::text)),result
      FROM public.financial_validation_runs WHERE id=$2`, [randomUUID(), source.id, randomUUID()]), { code: '23514' });
    const comparison = (await query('SELECT id FROM public.reconciliation_runs WHERE engine_version IS NOT NULL LIMIT 1')).rows[0];
    await assert.rejects(query(`INSERT INTO public.reconciliation_runs
      (id,tenant_id,left_document_id,right_document_id,requested_by,reconciliation_type,status,configuration,result_summary,started_at,finished_at,engine_version,financial_status,request_key,input_sha256,input_snapshot)
      SELECT $1::uuid,tenant_id,left_document_id,right_document_id,requested_by,reconciliation_type,status,configuration,result_summary,started_at,finished_at,engine_version,
      CASE WHEN financial_status='VALID' THEN 'WARNING' ELSE 'VALID' END,$1::uuid::text,input_sha256,input_snapshot
      FROM public.reconciliation_runs WHERE id=$2`, [randomUUID(), comparison.id]), { code: '23514' });
  });
  it('rolls back financial additions without deleting invoices, original snapshots or issue history', async () => {
    const before = (await admin.query('SELECT id,original_values FROM public.invoices ORDER BY id')).rows, issues = (await admin.query('SELECT id FROM public.validation_issues ORDER BY id')).rows;
    const rollbackCount=(await migrationStatus(admin)).filter(migration=>migration.status==='applied').length-7;
    await runMigrations(admin, { direction: 'down', count: rollbackCount });
    assert.deepEqual((await admin.query('SELECT id,original_values FROM public.invoices ORDER BY id')).rows, before);
    assert.deepEqual((await admin.query('SELECT id FROM public.validation_issues ORDER BY id')).rows, issues);
    assert.equal((await admin.query("SELECT to_regclass('public.financial_validation_runs') AS name")).rows[0].name, null);
    assert.equal((await runMigrations(admin)).length, rollbackCount);
    assert.equal((await query('SELECT financial_terms FROM public.invoices WHERE id=$1', [primary.invoiceIds[0]])).rows[0].financial_terms.constructor, Object);
  });
});
