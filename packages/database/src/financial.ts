import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { financialInvoiceSchema, financialTermsSchema, duplicateContextSchema, validationRunSchema, reconciliationRunSchema, reconciliationReportSchema } from '@doc/contracts';
import type { FinancialInvoice, FinancialRules, FinancialTermsPatch, FinancialValidationReport, ReconciliationReport, DuplicateContext } from '@doc/contracts';
import { validateInvoice, reconcileInvoices, financialStatus, FINANCE_ENGINE_VERSION } from '@doc/finance';
import { ServiceError } from '@doc/core';
import { withTenantTransaction } from './transactions.js';
import type { TenantContext } from './transactions.js';
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export const financialSnapshotHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function boundedJson(value: unknown, maximum: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maximum)
    throw new ServiceError('FINANCIAL_SNAPSHOT_LIMIT', 413, 'The source snapshot or report exceeds the financial request limit.');
  return serialized;
}
const invoiceFields = ['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency'];
const lineFields = ['description', 'quantity', 'unit_price', 'tax_rate', 'line_total'];
function originals(fields: string[], alias: string) { return 'jsonb_build_object(' + fields.map(field => `'${field}',${alias}.original_values->>'${field}'`).join(',') + ')'; }
const headerSql = `SELECT i.id,i.source_document_id AS document_id,i.source_candidate_id AS candidate_id,i.revision,i.invoice_number,i.invoice_date::text,i.supplier_name,i.customer_name,
  i.subtotal::text,i.tax::text,i.total::text,i.currency,i.financial_terms AS terms,i.field_evidence AS evidence,${originals(invoiceFields, 'i')} AS original_values,
  d.processing_status AS document_status,e.structured_result->'issues' AS extraction_issues
  FROM public.invoices i JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id)
  LEFT JOIN public.extraction_runs e ON (e.tenant_id,e.id)=(i.tenant_id,i.extraction_run_id)`;
/** Bounded exact-string source snapshot. Original/current values and source anchors remain separate. */
export async function readFinancialInvoice(client: pg.PoolClient, id: string): Promise<FinancialInvoice> {
  const row = (await client.query(headerSql + ' WHERE i.id=$1', [id])).rows[0];
  if (!row)
    throw new ServiceError('INVOICE_NOT_FOUND', 404, 'Invoice not found.');
  const lines = (await client.query(`SELECT l.id,l.line_number,l.revision,l.description,l.quantity::text,l.unit_price::text,l.tax_rate::text,l.line_total::text,l.source_evidence AS evidence,${originals(lineFields, 'l')} AS original_values FROM public.invoice_line_items l WHERE l.invoice_id=$1 ORDER BY l.line_number,l.id LIMIT 1001`, [id])).rows;
  if (lines.length > 1000)
    throw new ServiceError('FINANCIAL_LINE_LIMIT', 413, 'At most 1000 line items can be validated in one invoice.');
  const warnings: string[] = [];
  if (['failed', 'partially_processed', 'rejected', 'cancelled'].includes(row.document_status))
    warnings.push('PROCESSING_INCOMPLETE_OR_REJECTED');
  if (Array.isArray(row.extraction_issues)) {
    for (const issue of row.extraction_issues.slice(0, 199))
      if (typeof issue.code === 'string')
        warnings.push(issue.code);
    if (row.extraction_issues.length > 199)
      warnings.push('EXTRACTION_WARNINGS_TRUNCATED');
  }
  const { document_status: _status, extraction_issues: _issues, ...invoice } = row;
  return financialInvoiceSchema.parse({ ...invoice, source_warnings: [...new Set(warnings)], line_items: lines });
}
async function duplicateContext(client: pg.PoolClient, invoice: FinancialInvoice) {
  const documents = (await client.query("SELECT id AS document_id,sha256 FROM public.documents WHERE sha256=(SELECT sha256 FROM public.documents WHERE id=$1) AND id<>$1 AND NOT (metadata ? 'deleted') ORDER BY id LIMIT 101", [invoice.document_id])).rows;
  const candidates = (await client.query(`SELECT i.id,i.source_document_id AS document_id,i.source_candidate_id AS candidate_id,i.invoice_number,i.supplier_name,i.invoice_date::text,i.currency,i.total::text
    FROM public.invoices i JOIN public.documents d ON (d.tenant_id,d.id)=(i.tenant_id,i.source_document_id)
    LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id)
    WHERE NOT (d.metadata ? 'deleted') AND i.id<>$1 AND ($2::uuid IS NULL OR i.source_candidate_id IS DISTINCT FROM $2::uuid)
    AND (i.source_candidate_id IS NULL OR c.understanding_run_id::text=d.metadata#>>'{understanding,runId}')
    AND (i.source_candidate_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.invoices newer WHERE newer.tenant_id=i.tenant_id AND newer.source_candidate_id=i.source_candidate_id AND (newer.created_at,newer.id)>(i.created_at,i.id)))
    AND (public.finance_identity(i.invoice_number)=public.finance_identity($3) OR (i.invoice_date=$4::date AND i.currency=$5 AND i.total=$6::numeric))
    ORDER BY i.created_at DESC,i.id LIMIT 1001`, [invoice.id, invoice.candidate_id, invoice.invoice_number, invoice.invoice_date, invoice.currency, invoice.total])).rows;
  return duplicateContextSchema.parse({ exact_documents: documents.slice(0, 100), business_candidates: candidates.slice(0, 1000), truncated: documents.length > 100 || candidates.length > 1000 });
}
const legacySeverity = (severity: string) => severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'info';
async function persistIssues(client: pg.PoolClient, tenantId: string, runId: string, invoice: FinancialInvoice, report: FinancialValidationReport) {
  if (!report.issues.length)
    return;
  const rows = report.issues.map(issue => ({ ...issue, legacy_severity: legacySeverity(issue.severity) }));
  await client.query(`INSERT INTO public.validation_issues (tenant_id,document_id,invoice_id,financial_validation_run_id,issue_code,severity,field_path,message,expected_value,actual_value,related_document_id,related_invoice_id,financial_severity,manual_review_required,source_evidence)
    SELECT $1,$2,$3,$4::uuid,x.code,x.legacy_severity,x.field,'Deterministic financial validation: '||x.code,to_jsonb(x.expected),to_jsonb(x.actual),x.related_document_id,x.related_invoice_id,x.severity,x.manual_review_required,jsonb_build_object('validation_run_id',$4::uuid::text,'evidence',x.evidence)
    FROM jsonb_to_recordset($5::jsonb) AS x(code text,legacy_severity text,field text,expected text,actual text,related_document_id uuid,related_invoice_id uuid,severity text,manual_review_required boolean,evidence jsonb)`, [tenantId, invoice.document_id, invoice.id, runId, JSON.stringify(rows)]);
}
export class FinancialRepository {
  constructor(private readonly pool: pg.Pool) { }
  private async tx<T>(context: TenantContext, operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTenantTransaction(this.pool, context, operation, { isolationLevel: 'repeatable read' });
      }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const constraint = error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : '';
        const keyRace = code === '23505' && ['financial_validation_runs_tenant_id_invoice_id_request_key_key', 'reconciliation_request_key_idx'].includes(constraint);
        if (['40001', '40P01'].includes(code) || keyRace) {
          if (attempt < 2)
            continue;
          throw new ServiceError('FINANCIAL_SOURCE_BUSY', 409, 'Source changed concurrently; retry the request.');
        }
        if (code === '57014')
          throw new ServiceError('FINANCIAL_CAPACITY_REACHED', 503, 'Financial database processing exceeded its time budget; retry later.');
        throw error;
      }
    }
  }
  async updateTerms(context: TenantContext, id: string, revision: number, patch: FinancialTermsPatch) {
    return this.tx(context, async (client) => {
      const invoice = await readFinancialInvoice(client, id);
      if (invoice.revision !== revision)
        throw new ServiceError('INVOICE_REVISION_CONFLICT', 409, 'Invoice changed; reload before correcting financial terms.');
      const terms = financialTermsSchema.parse({ ...invoice.terms, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
      const result = await client.query('UPDATE public.invoices SET financial_terms=$2 WHERE id=$1 AND revision=$3 RETURNING revision', [id, JSON.stringify(terms), revision]);
      if (!result.rowCount)
        throw new ServiceError('INVOICE_REVISION_CONFLICT', 409, 'Invoice changed; reload before correcting financial terms.');
      return { invoice_id: id, revision: result.rows[0].revision, terms };
    });
  }
  private async validationDto(client: pg.PoolClient, row: pg.QueryResultRow, live?: {
    invoice: FinancialInvoice;
    duplicates: DuplicateContext;
  }) {
    const current = live?.invoice ?? await readFinancialInvoice(client, row.invoice_id);
    const duplicates = live?.duplicates ?? await duplicateContext(client, current);
    return validationRunSchema.parse({
      id: row.id, invoice_id: row.invoice_id, document_id: row.document_id, created_at: row.created_at.toISOString(), status: row.financial_status,
      rules: row.rules, input_sha256: row.input_sha256, snapshot: row.input_snapshot, result: row.result, is_current: row.engine_version === FINANCE_ENGINE_VERSION && financialSnapshotHash({ invoice: current, duplicates }) === financialSnapshotHash(row.input_snapshot)
    });
  }
  async validate(context: TenantContext, id: string, key: string, rules: FinancialRules) {
    return this.tx(context, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [context.tenantId + ':financial:' + id]);
      const previous = (await client.query('SELECT * FROM public.financial_validation_runs WHERE invoice_id=$1 AND request_key=$2', [id, key])).rows[0];
      if (previous) {
        if (financialSnapshotHash(previous.rules) !== financialSnapshotHash(rules))
          throw new ServiceError('IDEMPOTENCY_CONFLICT', 409, 'This key was already used with different validation rules.');
        return { replayed: true, run: await this.validationDto(client, previous) };
      }
      const invoice = await readFinancialInvoice(client, id), duplicates = await duplicateContext(client, invoice), snapshot = { invoice, duplicates };
      const report = validateInvoice(invoice, rules, duplicates), runId = randomUUID(), hash = financialSnapshotHash({ snapshot, rules, engine: FINANCE_ENGINE_VERSION });
      const row = (await client.query(`INSERT INTO public.financial_validation_runs (id,tenant_id,document_id,invoice_id,requested_by,request_key,engine_version,input_sha256,financial_status,rules,input_snapshot,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [runId, context.tenantId, invoice.document_id, id, context.actorUserId ?? null, key, FINANCE_ENGINE_VERSION, hash, report.status, JSON.stringify(rules), boundedJson(snapshot, 8388608), boundedJson(report, 8388608)])).rows[0];
      await persistIssues(client, context.tenantId, runId, invoice, report);
      return { replayed: false, run: await this.validationDto(client, row) };
    });
  }
  async validationHistory(context: TenantContext, id: string, limit: number) {
    return this.tx(context, async (client) => {
      const invoice = await readFinancialInvoice(client, id);
      const duplicates = await duplicateContext(client, invoice);
      const rows = (await client.query('SELECT * FROM public.financial_validation_runs WHERE invoice_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [id, limit])).rows;
      const runs = [];
      for (const row of rows)
        runs.push(await this.validationDto(client, row, { invoice, duplicates }));
      return { invoice, financial_status: runs[0] ? (runs[0].is_current ? runs[0].status : 'REVIEW_REQUIRED') : null, stale: runs[0] ? !runs[0].is_current : false, runs };
    });
  }
  private async documentInvoices(client: pg.PoolClient, id: string, allowDeleted = false) {
    const document = (await client.query(allowDeleted ? 'SELECT id,mime_type,processing_status,metadata FROM public.documents WHERE id=$1' : "SELECT id,mime_type,processing_status,metadata FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
    if (!document)
      throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
    const ids = (await client.query(`SELECT DISTINCT ON (COALESCE(i.source_candidate_id,i.id)) i.id,i.created_at FROM public.invoices i
      LEFT JOIN public.invoice_candidates c ON (c.tenant_id,c.id)=(i.tenant_id,i.source_candidate_id)
      WHERE i.source_document_id=$1 AND (i.source_candidate_id IS NULL OR c.understanding_run_id::text=$2)
      ORDER BY COALESCE(i.source_candidate_id,i.id),i.created_at DESC,i.id DESC LIMIT 101`, [id, document.metadata.understanding?.runId ?? null])).rows;
    if (ids.length > 100)
      throw new ServiceError('RECONCILIATION_INVOICE_LIMIT', 413, 'At most 100 current invoice records per document can be reconciled.');
    const invoices: FinancialInvoice[] = [];
    let lineCount = 0;
    for (const row of ids) {
      const invoice = await readFinancialInvoice(client, row.id);
      lineCount += invoice.line_items.length;
      if (lineCount > 1000)
        throw new ServiceError('RECONCILIATION_LINE_LIMIT', 413, 'At most 1000 line items per document can be reconciled.');
      invoices.push(invoice);
    }
    invoices.sort((a, b) => a.id.localeCompare(b.id));
    const coverage = (await client.query(`SELECT count(*) FILTER(WHERE document_type='invoice')::integer AS expected_invoices,
      count(*) FILTER(WHERE document_type='unknown' OR data->'review_reasons' ?| ARRAY['AMBIGUOUS_BOUNDARY','CONFLICTING_PAGE_IDENTITIES','CANDIDATE_LIMIT_EXCEEDED'])::integer AS unresolved_candidates
      FROM public.invoice_candidates WHERE document_id=$1 AND understanding_run_id=$2::uuid`, [id, document.metadata.understanding?.runId ?? null])).rows[0];
    return {
      document, invoices, coverage: {
        understanding_run_id: document.metadata.understanding?.runId ?? null, expected_invoices: coverage.expected_invoices, unresolved_candidates: coverage.unresolved_candidates,
        extracted_invoices: invoices.length, processing_status: document.processing_status
      }
    };
  }
  private async reconciliationSnapshot(client: pg.PoolClient, leftId: string, rightId: string, allowDeleted = false) {
    const left = await this.documentInvoices(client, leftId, allowDeleted), right = await this.documentInvoices(client, rightId, allowDeleted);
    if (left.document.mime_type !== 'application/pdf' || !['application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'].includes(right.document.mime_type))
      throw new ServiceError('UNSUPPORTED_RECONCILIATION_FORMATS', 400, 'Use a PDF on the left and a PDF, XLSX, XLS or CSV on the right.');
    const deleted = Boolean(left.document.metadata?.deleted || right.document.metadata?.deleted);
    return { snapshot: { left: left.invoices, right: right.invoices, coverage: { left: left.coverage, right: right.coverage } }, type: right.document.mime_type === 'application/pdf' ? 'pdf_to_pdf' : 'pdf_to_spreadsheet', deleted };
  }
  private async reconciliationDto(client: pg.PoolClient, row: pg.QueryResultRow) {
    const current = await this.reconciliationSnapshot(client, row.left_document_id, row.right_document_id, true);
    return reconciliationRunSchema.parse({
      id: row.id, left_document_id: row.left_document_id, right_document_id: row.right_document_id, created_at: row.created_at.toISOString(), processing_status: row.status,
      financial_status: row.financial_status, rules: row.configuration, input_sha256: row.input_sha256, snapshot: row.input_snapshot, result: row.result_summary,
      is_current: !current.deleted && row.engine_version === FINANCE_ENGINE_VERSION && financialSnapshotHash(current.snapshot) === financialSnapshotHash(row.input_snapshot)
    });
  }
  async reconcile(context: TenantContext, leftId: string, rightId: string, key: string, rules: FinancialRules) {
    if (leftId === rightId)
      throw new ServiceError('SAME_RECONCILIATION_DOCUMENT', 400, 'Choose two different source documents.');
    return this.tx(context, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [context.tenantId + ':reconciliation:' + key]);
      const previous = (await client.query('SELECT * FROM public.reconciliation_runs WHERE request_key=$1', [key])).rows[0];
      if (previous) {
        if (previous.left_document_id !== leftId || previous.right_document_id !== rightId || financialSnapshotHash(previous.configuration) !== financialSnapshotHash(rules))
          throw new ServiceError('IDEMPOTENCY_CONFLICT', 409, 'This key was used for different sources or reconciliation rules.');
        return { replayed: true, run: await this.reconciliationDto(client, previous) };
      }
      const { snapshot, type } = await this.reconciliationSnapshot(client, leftId, rightId), report = reconcileInvoices(snapshot.left, snapshot.right, rules);
      for (const [side, coverage] of Object.entries(snapshot.coverage))
        if (!coverage.understanding_run_id || coverage.unresolved_candidates > 0 || coverage.expected_invoices !== coverage.extracted_invoices || !['processed', 'needs_review'].includes(coverage.processing_status))
          report.issues.push({ code: 'DOCUMENT_COVERAGE_INCOMPLETE', field: side, expected: null, actual: null, severity: 'high', manual_review_required: true, related_document_id: side === 'right' ? rightId : leftId, related_invoice_id: null, evidence: coverage });
      for (const invoice of [...snapshot.left, ...snapshot.right])
        for (const warning of invoice.source_warnings)
          report.issues.push({ code: 'SOURCE_' + warning, field: 'source', expected: null, actual: null, severity: 'medium', manual_review_required: true, related_document_id: invoice.document_id, related_invoice_id: invoice.id, evidence: {} });
      report.status = financialStatus(report.issues);
      reconciliationReportSchema.parse(report);
      const id = randomUUID(), hash = financialSnapshotHash({ snapshot, rules, engine: FINANCE_ENGINE_VERSION });
      const row = (await client.query(`INSERT INTO public.reconciliation_runs (id,tenant_id,left_document_id,right_document_id,requested_by,reconciliation_type,status,configuration,result_summary,started_at,finished_at,engine_version,financial_status,request_key,input_sha256,input_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8,clock_timestamp(),clock_timestamp(),$9,$10,$11,$12,$13) RETURNING *`, [id, context.tenantId, leftId, rightId, context.actorUserId ?? null, type, JSON.stringify(rules), boundedJson(report, 16777216), FINANCE_ENGINE_VERSION, report.status, key, hash, boundedJson(snapshot, 16777216)])).rows[0];
      await this.persistComparisons(client, context.tenantId, id, leftId, rightId, report);
      return { replayed: false, run: await this.reconciliationDto(client, row) };
    });
  }
  private async persistComparisons(client: pg.PoolClient, tenantId: string, id: string, leftId: string, rightId: string, report: ReconciliationReport) {
    if (!report.comparisons.length)
      return;
    const rows = report.comparisons.map(item => ({ ...item, legacy_severity: item.severity ? legacySeverity(item.severity) : null }));
    await client.query(`INSERT INTO public.reconciliation_items (tenant_id,reconciliation_run_id,left_document_id,right_document_id,left_invoice_id,right_invoice_id,field_path,match_status,issue_code,severity,expected_value,actual_value,source_evidence,financial_severity,manual_review_required)
      SELECT $1,$2,$3,$4,x.left_invoice_id,x.right_invoice_id,x.field,x.match_status,x.code,x.legacy_severity,to_jsonb(x.expected),to_jsonb(x.actual),x.evidence,x.severity,x.manual_review_required
      FROM jsonb_to_recordset($5::jsonb) AS x(left_invoice_id uuid,right_invoice_id uuid,field text,match_status text,code text,legacy_severity text,expected text,actual text,evidence jsonb,severity text,manual_review_required boolean)`, [tenantId, id, leftId, rightId, JSON.stringify(rows)]);
  }
  async getReconciliation(context: TenantContext, id: string) {
    return this.tx(context, async (client) => {
      const row = (await client.query('SELECT * FROM public.reconciliation_runs WHERE id=$1 AND engine_version IS NOT NULL', [id])).rows[0];
      if (!row)
        throw new ServiceError('RECONCILIATION_NOT_FOUND', 404, 'Reconciliation not found.');
      return this.reconciliationDto(client, row);
    });
  }
}
