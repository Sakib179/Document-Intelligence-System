import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { financialTermsSchema, financialTermsUpdateSchema, financialRulesSchema } from '@doc/contracts';
import { validateInvoice, detectDuplicates, reconcileInvoices } from '@doc/finance';
import { invoiceFixture, lineFixture, matchingCopy } from '../fixtures/finance.js';
const codes = (invoice: ReturnType<typeof invoiceFixture>, rules: Parameters<typeof validateInvoice>[1] = {}) => validateInvoice(invoice, rules).issues.map(issue => issue.code);
describe('deterministic decimal financial validation', () => {
  it('validates complete explicit tax-exclusive inputs without changing any reported value', () => {
    const invoice = invoiceFixture(), before = structuredClone(invoice), report = validateInvoice(invoice);
    expect(report.status).toBe('VALID');
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(invoice).toEqual(before);
  });
  it('preserves omitted PATCH fields rather than resetting confirmed terms', () => {
    const patch = financialTermsUpdateSchema.parse({ revision: 1, reason: 'Correct printed charge', terms: { charges: '5' } });
    expect(patch.terms).toEqual({ charges: '5' });
  });
  it('uses a private Decimal precision independent of process-wide settings', () => {
    const precision = Decimal.precision;
    try {
      Decimal.set({ precision: 2 });
      expect(validateInvoice(invoiceFixture()).status).toBe('VALID');
    }
    finally {
      Decimal.set({ precision });
    }
  });
  it('computes fractional products exactly without binary floating-point artifacts', () => {
    const invoice = invoiceFixture({ subtotal: '0.02', tax: '0', total: '0.02', line_items: [lineFixture({ quantity: '0.1', unit_price: '0.2', tax_rate: '0', line_total: '0.02' })] });
    expect(validateInvoice(invoice).status).toBe('VALID');
  });
  it('preserves monetary precision above the JavaScript safe integer boundary', () => {
    const invoice = invoiceFixture({ subtotal: '9999999999999999.99', tax: '0', total: '9999999999999999.99', line_items: [lineFixture({ quantity: '1', unit_price: '9999999999999999.99', tax_rate: '0', line_total: '9999999999999999.99' })] });
    const report = validateInvoice(invoice);
    expect(report.status).toBe('VALID');
    expect(report.checks.find(check => check.code === 'TOTAL_MISMATCH')?.expected).toBe('9999999999999999.99');
  });
  it('supports configurable mandatory fields without making missing arithmetic inputs valid', () => {
    const invoice = invoiceFixture({ invoice_number: null, customer_name: null });
    expect(codes(invoice)).toContain('MISSING_MANDATORY_FIELD');
    expect(validateInvoice(invoice, { required_fields: ['subtotal', 'tax', 'total', 'currency'] }).status).toBe('VALID');
    invoice.total = null;
    expect(validateInvoice(invoice, { required_fields: [] }).status).toBe('REVIEW_REQUIRED');
  });
  it.each(['NaN', 'Infinity', '1e3', '1,000.00', ' 10', '', '1.123456789'])('reports invalid numeric string %j', value => {
    expect(codes(invoiceFixture({ total: value }))).toContain('INVALID_NUMERIC_STRING');
  });
  it('flags negative quantities and amounts unless the caller explicitly supports signed records', () => {
    const invoice = invoiceFixture({ subtotal: '-100', tax: '-15', total: '-115', line_items: [lineFixture({ quantity: '-2', line_total: '-100' })] });
    expect(codes(invoice)).toContain('NEGATIVE_VALUE_NOT_ALLOWED');
    expect(validateInvoice(invoice, { allow_negative_values: true }).status).toBe('VALID');
  });
  it('checks zero quantities using configurable rules', () => {
    const invoice = invoiceFixture({ subtotal: '0', tax: '0', total: '0', line_items: [lineFixture({ quantity: '0', line_total: '0' })] });
    expect(codes(invoice)).toContain('INVALID_QUANTITY');
    expect(validateInvoice(invoice, { allow_zero_quantity: true }).status).toBe('VALID');
  });
  it.each(['-0.1', '1.1', '15%'])('rejects invalid tax rate %s', rate => {
    expect(validateInvoice(invoiceFixture({ line_items: [lineFixture({ tax_rate: rate })] })).status).toBe('REVIEW_REQUIRED');
  });
  it('reports a line mismatch without repairing the source amount', () => {
    const invoice = invoiceFixture({ line_items: [lineFixture({ line_total: '99' })] }), report = validateInvoice(invoice);
    expect(report.issues.find(issue => issue.code === 'LINE_AMOUNT_MISMATCH')).toMatchObject({ field: 'line_items.0.line_total', expected: '100.00', actual: '99', severity: 'high', manual_review_required: true });
    expect(invoice.line_items[0]?.line_total).toBe('99');
  });
  it('sums multiple applicable reported lines and flags subtotal mismatches', () => {
    const invoice = invoiceFixture({ subtotal: '3.05', tax: '0', total: '3.05', line_items: [lineFixture({ quantity: '1', unit_price: '1.02', tax_rate: '0', line_total: '1.02' }), lineFixture({ line_number: 2, quantity: '1', unit_price: '2.03', tax_rate: '0', line_total: '2.03' })] });
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.subtotal = '3.00';
    expect(codes(invoice)).toContain('SUBTOTAL_MISMATCH');
  });
  it('honors explicit line exclusions and flags nonexistent exclusion references', () => {
    const invoice = invoiceFixture();
    const excluded = lineFixture({ line_number: 2, description: 'Display summary', quantity: '1', unit_price: '7', tax_rate: '0', line_total: '7' });
    invoice.line_items.push(excluded);
    invoice.terms.excluded_line_item_ids = [excluded.id];
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.terms.excluded_line_item_ids.push(randomUUID());
    expect(codes(invoice)).toContain('UNKNOWN_EXCLUDED_LINE');
  });
  it('includes explicit charges, discounts and withholding in expected totals', () => {
    const invoice = invoiceFixture({ total: '120' });
    Object.assign(invoice.terms, { charges: '10', discounts: '2', withholding: '3', tax_scope: 'reported' });
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.total = '125';
    expect(codes(invoice)).toContain('TOTAL_MISMATCH');
  });
  it('does not assume unknown adjustments, tax basis or source coverage', () => {
    const invoice = invoiceFixture();
    invoice.terms = financialTermsSchema.parse({});
    const report = validateInvoice(invoice);
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['ADJUSTMENTS_UNCONFIRMED', 'TAX_METHOD_UNIDENTIFIED', 'LINE_ITEM_COVERAGE_UNCONFIRMED', 'TOTAL_CALCULATION_INCOMPLETE']));
    expect(report.checks.find(check => check.code === 'TOTAL_MISMATCH')?.status).toBe('skipped');
  });
  it('does not substitute zero for a missing adjustment even after completeness confirmation', () => {
    const invoice = invoiceFixture();
    invoice.terms.discounts = null;
    expect(codes(invoice)).toContain('TOTAL_CALCULATION_INCOMPLETE');
  });
  it('supports tax-inclusive gross amounts without adding included tax twice', () => {
    const invoice = invoiceFixture({ subtotal: '115', total: '115', line_items: [lineFixture({ quantity: '1', unit_price: '115', line_total: '115' })] });
    Object.assign(invoice.terms, { tax_mode: 'inclusive', subtotal_basis: 'gross', line_amount_basis: 'gross' });
    expect(validateInvoice(invoice).status).toBe('VALID');
  });
  it('converts explicit gross lines to a stated net subtotal using printed tax rates', () => {
    const invoice = invoiceFixture({ line_items: [lineFixture({ quantity: '1', unit_price: '115', line_total: '115' })] });
    Object.assign(invoice.terms, { tax_mode: 'inclusive', subtotal_basis: 'net', line_amount_basis: 'gross' });
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.line_items[0]!.tax_rate = null;
    expect(codes(invoice)).toContain('LINE_TAX_RATE_REQUIRED');
  });
  it('flags conflicting exclusive/gross treatment and nonzero exempt tax', () => {
    const invoice = invoiceFixture();
    invoice.terms.subtotal_basis = 'gross';
    expect(codes(invoice)).toContain('TAX_BASIS_CONFLICT');
    invoice.terms.tax_mode = 'exempt';
    expect(codes(invoice)).toContain('EXEMPT_TAX_NONZERO');
    invoice.terms.subtotal_basis = 'net';
    invoice.tax = '0';
    invoice.total = '100';
    invoice.line_items[0]!.tax_rate = '0';
    expect(validateInvoice(invoice).status).toBe('VALID');
  });
  it('does not infer the tax treatment of nonzero adjustments', () => {
    const invoice = invoiceFixture();
    invoice.terms.charges = '10';
    invoice.total = '125';
    expect(codes(invoice)).toContain('TAX_SCOPE_UNCONFIRMED');
  });
  it('supports explicit aggregate or per-line tax rounding and half-even ties', () => {
    const invoice = invoiceFixture({ subtotal: '0.10', tax: '0.02', total: '0.12', line_items: [1, 2].map(line_number => lineFixture({ line_number, quantity: '1', unit_price: '0.05', line_total: '0.05', tax_rate: '0.1' })) });
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.tax = '0.01';
    invoice.total = '0.11';
    expect(validateInvoice(invoice, { tax_rounding: 'aggregate' }).status).toBe('VALID');
    invoice.tax = '0';
    invoice.total = '0.10';
    expect(validateInvoice(invoice, { rounding_mode: 'half_even' }).status).toBe('VALID');
  });
  it('checks mixed printed line rates for both net and tax-inclusive gross amounts', () => {
    const invoice = invoiceFixture({
      subtotal: '150', tax: '20', total: '170', line_items: [
        lineFixture({ quantity: '1', unit_price: '100', line_total: '100', tax_rate: '0.15' }),
        lineFixture({ line_number: 2, description: 'Other item', quantity: '1', unit_price: '50', line_total: '50', tax_rate: '0.10' })
      ]
    });
    expect(validateInvoice(invoice).status).toBe('VALID');
    Object.assign(invoice.terms, { tax_mode: 'inclusive', subtotal_basis: 'gross', line_amount_basis: 'gross' });
    invoice.subtotal = '170';
    invoice.line_items[0]!.unit_price = invoice.line_items[0]!.line_total = '115';
    invoice.line_items[1]!.unit_price = invoice.line_items[1]!.line_total = '55';
    expect(validateInvoice(invoice).status).toBe('VALID');
  });
  it('supports a documented aggregate product-sum convention separately from reported-line sums', () => {
    const invoice = invoiceFixture({ subtotal: '2.02', tax: '0', total: '2.02', line_items: [1, 2].map(line_number => lineFixture({ line_number, quantity: '3', unit_price: '0.335', line_total: '1.01', tax_rate: '0' })) });
    expect(validateInvoice(invoice).status).toBe('VALID');
    invoice.subtotal = invoice.total = '2.01';
    expect(validateInvoice(invoice, { sum_rounding: 'round_sum_products' }).status).toBe('VALID');
  });
  it.each([['USD', '115.01', 2], ['JPY', '116', 0], ['KWD', '115.001', 3], ['CLF', '115.0001', 4]] as const)('uses %s minor units for tolerance', (currency, total, digits) => {
    const report = validateInvoice(invoiceFixture({ currency, total }));
    expect(report.minor_units).toBe(digits);
    expect(report.status).toBe('WARNING');
  });
  it('rejects amounts beyond tolerance and allows a currency-specific exact policy', () => {
    expect(validateInvoice(invoiceFixture({ total: '115.02' })).status).toBe('REVIEW_REQUIRED');
    expect(validateInvoice(invoiceFixture({ total: '115.01' }), { currency_overrides: { USD: { tolerance_minor_units: '0' } } }).status).toBe('REVIEW_REQUIRED');
  });
  it.each(['usd', 'US', 'ZZZ', '$'])('flags invalid or ambiguous currency %j', currency => expect(codes(invoiceFixture({ currency }))).toContain('INVALID_CURRENCY'));
  it('retains uncertainty from source extraction instead of returning a financial VALID', () => {
    expect(validateInvoice(invoiceFixture({ source_warnings: ['SOURCE_CONTEXT_TRUNCATED'] })).status).toBe('REVIEW_REQUIRED');
  });
});
describe('duplicate candidates without automatic rejection', () => {
  it('flags exact SHA-256 duplicates with the other source reference', () => {
    const invoice = invoiceFixture(), other = randomUUID(), result = validateInvoice(invoice, {}, { exact_documents: [{ document_id: other, sha256: 'a'.repeat(64) }] });
    expect(result.issues.find(issue => issue.code === 'EXACT_FILE_DUPLICATE')?.related_document_id).toBe(other);
    expect(result.status).toBe('REVIEW_REQUIRED');
  });
  it('uses all five business signals but permits conflicting repeats to remain review candidates', () => {
    const invoice = invoiceFixture(), other = matchingCopy(invoice);
    let result = detectDuplicates(invoice, { exact_documents: [], business_candidates: [other], truncated: false });
    expect(result[0]?.evidence.matched_signal_count).toBe(5);
    other.total = '200';
    other.invoice_date = '2026-11-16';
    result = detectDuplicates(invoice, { exact_documents: [], business_candidates: [other], truncated: false });
    expect(result).toHaveLength(1);
  });
  it('does not flag weak supplier/amount coincidences or another version of the same candidate', () => {
    const invoice = invoiceFixture(), other = matchingCopy(invoice);
    other.invoice_number = 'UNRELATED';
    other.invoice_date = '2026-10-01';
    expect(detectDuplicates(invoice, { exact_documents: [], business_candidates: [other], truncated: false })).toEqual([]);
    other.invoice_number = invoice.invoice_number;
    other.candidate_id = invoice.candidate_id;
    other.document_id = invoice.document_id;
    expect(detectDuplicates(invoice, { exact_documents: [], business_candidates: [other], truncated: false })).toEqual([]);
  });
  it('flags incomplete duplicate scans rather than asserting no duplicates', () => {
    expect(detectDuplicates(invoiceFixture(), { exact_documents: [], business_candidates: [], truncated: true })[0]?.code).toBe('DUPLICATE_SCAN_TRUNCATED');
  });
});
describe('deterministic cross-document reconciliation', () => {
  it('matches equivalent invoices and line items with complete original and source snapshots', () => {
    const left = invoiceFixture(), right = matchingCopy(left), before = structuredClone([left, right]), report = reconcileInvoices([left], [right]);
    expect(report.status).toBe('VALID');
    expect(report.pairs[0]?.right_invoice_id).toBe(right.id);
    expect(report.comparisons[0]?.evidence).toHaveProperty('left.original_values');
    expect([left, right]).toEqual(before);
  });
  it.each(['invoice_number', 'supplier_name', 'invoice_date', 'subtotal', 'tax', 'total', 'currency'] as const)('reports %s differences without rewriting either document', field => {
    const left = invoiceFixture(), right = matchingCopy(left);
    right[field] = field === 'invoice_number' ? 'DIFFERENT' : field === 'supplier_name' ? 'Different Supplier' : field === 'invoice_date' ? '2026-11-16' : field === 'currency' ? 'EUR' : '120.00';
    const report = reconcileInvoices([left], [right]);
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.comparisons.some(item => item.field === field && item.match_status !== 'matched')).toBe(true);
  });
  it('matches document bundles by identity even when record order changes', () => {
    const a = invoiceFixture(), b = invoiceFixture({ invoice_number: 'INV-202', supplier_name: 'Other Supplier' }), x = matchingCopy(a), y = matchingCopy(b);
    const report = reconcileInvoices([a, b], [y, x]);
    expect(report.status).toBe('VALID');
    expect(report.pairs.map(pair => pair.right_invoice_id)).toEqual([x.id, y.id]);
  });
  it('never arbitrarily pairs ambiguous repeated invoice identities', () => {
    const invoice = invoiceFixture(), a = matchingCopy(invoice), b = matchingCopy(invoice), report = reconcileInvoices([invoice], [a, b]);
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.pairs[0]?.right_invoice_id).toBeNull();
    expect(report.pairs[0]?.candidate_right_ids).toHaveLength(2);
  });
  it('retains unmatched records from both documents', () => {
    const left = invoiceFixture(), right = invoiceFixture({ invoice_number: 'OTHER', supplier_name: 'Unrelated', total: '5', invoice_date: '2026-10-01' }), report = reconcileInvoices([left], [right]);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['INVOICE_MISSING_RIGHT', 'INVOICE_MISSING_LEFT']));
  });
  it('checks line quantities exactly rather than applying currency tolerances', () => {
    const left = invoiceFixture(), right = matchingCopy(left);
    right.line_items[0]!.quantity = '2.001';
    expect(reconcileInvoices([left], [right]).issues.some(issue => issue.field.endsWith('.quantity'))).toBe(true);
  });
  it('compares repeated identical line items as multisets and preserves multiplicity', () => {
    const left = invoiceFixture();
    left.line_items.push(lineFixture({ line_number: 2 }));
    const right = matchingCopy(left);
    expect(reconcileInvoices([left], [right]).status).toBe('VALID');
    right.line_items.pop();
    expect(reconcileInvoices([left], [right]).status).toBe('REVIEW_REQUIRED');
  });
  it('retains Excel worksheet/cell evidence and original/current discrepancies', () => {
    const left = invoiceFixture(), right = matchingCopy(left);
    right.evidence = { worksheet: 'Invoices', cell: 'G2', text: '120.00' };
    right.total = '120.00';
    const report = reconcileInvoices([left], [right]), comparison = report.comparisons.find(item => item.field === 'total')!;
    expect(comparison.expected).toBe('115.00');
    expect(comparison.actual).toBe('120.00');
    expect(comparison.evidence).toHaveProperty('right.source.cell', 'G2');
  });
  it('requires review when a spreadsheet summary cannot support a line-item comparison', () => {
    const left = invoiceFixture(), right = matchingCopy(left);
    right.line_items = [];
    right.terms.line_items_complete = false;
    expect(reconcileInvoices([left], [right]).issues.some(issue => issue.code === 'LINE_ITEMS_UNAVAILABLE')).toBe(true);
  });
  it('reports a permitted rounding difference as WARNING without changing reported amounts', () => {
    const left = invoiceFixture(), right = matchingCopy(left);
    right.total = '115.01';
    const report = reconcileInvoices([left], [right]);
    expect(report.status).toBe('WARNING');
    expect(report.comparisons.find(item => item.field === 'total')?.actual).toBe('115.01');
  });
  it('rejects malformed configurable policies', () => expect(() => financialRulesSchema.parse({ tolerance_minor_units: 'NaN' })).toThrow());
});
