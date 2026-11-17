import { describe, it, expect } from 'vitest';
import { allowedProxyPath, sameOrigin } from '../../apps/web/src/lib/security.js';
import { validateUploadFiles } from '../../apps/web/src/lib/upload.js';
import { searchQuerySchema } from '@doc/contracts';
import { evidenceLocation } from '../../apps/web/src/lib/evidence.js';
import { formatAmount, formatInputNumber, formatQuantity, formatTaxRate, formatFieldPath, parseAuditDiff, parseIndexedSummary } from '../../apps/web/src/lib/format.js';
import { computeInvoiceVisualAnalytics, computeValidationAnalytics, describeValidationIssue } from '../../apps/web/src/lib/validation-copy.js';
describe('frontend security and input contracts', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('permits only supported API paths and methods', () => {
    for (const path of ['dashboard', 'me', 'workspace/documents', 'documents/' + id + '/preview', 'documents/' + id + '/pages/1'])
      expect(allowedProxyPath(path, 'GET')).toBe(true);
    for (const path of ['../me', 'documents/%2e%2e/me', 'https://example.com', 'documents//x', 'documents/' + id + '/privacy'])
      expect(allowedProxyPath(path, 'GET')).toBe(false);
    expect(allowedProxyPath('dashboard', 'POST')).toBe(false);
    expect(allowedProxyPath('invoices/' + id, 'PATCH')).toBe(true);
    expect(allowedProxyPath('documents/' + id, 'DELETE')).toBe(true);
    expect(allowedProxyPath('documents', 'DELETE')).toBe(false);
  });
  it('requires an exact origin for browser writes', () => {
    expect(sameOrigin(new Request('https://local.test/api/backend/documents', { headers: { origin: 'https://local.test' } }))).toBe(true);
    for (const origin of ['https://evil.test', 'null', 'https://local.test:444'])
      expect(sameOrigin(new Request('https://local.test/api/backend/documents', { headers: { origin } }))).toBe(false);
    expect(sameOrigin(new Request('https://local.test/api/backend/documents'))).toBe(false);
  });
  it('uses the browser-facing Host when Next reconstructs an internal hostname', () => {
    const url = 'http://localhost:3000/api/backend/documents';
    expect(sameOrigin(new Request(url, { headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' } }))).toBe(true);
    for (const headers of [
      { host: '127.0.0.1:3000', origin: 'https://evil.test' },
      { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3001' },
      { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'cross-site' },
      { host: '127.0.0.1:3000', origin: 'https://evil.test', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
    ]) expect(sameOrigin(new Request(url, { headers }))).toBe(false);
  });
  it('validates extension, empty files, count and byte limits', () => {
    const limits = { max_files: 2, max_file_bytes: 10, max_batch_bytes: 15 };
    expect(validateUploadFiles([{ name: 'invoice.pdf', size: 5 }, { name: 'ledger.CSV', size: 5 }], limits)).toEqual([]);
    for (const files of [[], [{ name: 'script.exe', size: 1 }], [{ name: 'empty.pdf', size: 0 }], [{ name: 'large.pdf', size: 11 }], [{ name: 'a.pdf', size: 8 }, { name: 'b.pdf', size: 8 }], [{ name: 'a.pdf', size: 1 }, { name: 'b.pdf', size: 1 }, { name: 'c.pdf', size: 1 }]])
      expect(validateUploadFiles(files, limits).length).toBeGreaterThan(0);
  });
  it('accepts exact currency/amount SQL filters and rejects numeric coercion', () => {
    expect(searchQuerySchema.parse({ mode: 'filter', currency: 'BDT', amount_min: '9999999999999999.99' }).amount_min).toBe('9999999999999999.99');
    expect(searchQuerySchema.safeParse({ mode: 'filter' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ mode: 'filter', currency: 'BDT', amount_min: 0.1 }).success).toBe(false);
  });
  it('finds real page and worksheet coordinates in nested line-item evidence', () => {
    expect(evidenceLocation({ description: { evidence: { page: 3, text: 'Widget quantity two' } } })).toEqual({ page: 3, text: 'Widget quantity two' });
    expect(evidenceLocation({ evidence: { worksheet: 'Ledger', cell: 'B4', text: '115.00' } })).toEqual({ worksheet: 'Ledger', cell: 'B4', text: '115.00' });
    expect(evidenceLocation(null)).toEqual({});
  });
  it('formats decimal strings with at most 2 decimals and no unnecessary trailing zeros', () => {
    expect(formatAmount('100.00000000', 'USD')).toBe('100');
    expect(formatAmount('155311.00000000', 'BDT')).toBe('155,311');
    expect(formatAmount('100448.25000000', 'BDT')).toBe('100,448.25');
    expect(formatAmount('9999999999999999.12345678', 'USD')).toBe('9,999,999,999,999,999.12');
    expect(formatAmount('99.99600000', 'USD')).toBe('100');
    expect(formatAmount('1250.00000000', 'JPY')).toBe('1,250');
    expect(formatInputNumber('146000.00000000')).toBe('146000');
    expect(formatInputNumber('100448.25000000')).toBe('100448.25');
    expect(formatInputNumber('40.00000000')).toBe('40');
    expect(formatInputNumber('12.34600000')).toBe('12.35');
    expect(formatQuantity('2.00000000')).toBe('2');
    expect(formatQuantity('2.50000000')).toBe('2.5');
    expect(formatQuantity('2.34600000')).toBe('2.35');
    expect(formatTaxRate('0.150000')).toBe('15%');
    expect(formatTaxRate('0.075000')).toBe('7.5%');
    expect(formatFieldPath('line_items.1.unit_price')).toBe('Line 1 · Unit price');
    expect(formatFieldPath('terms.tax_mode')).toBe('Tax method');
    expect(parseAuditDiff('{"total":"115.00000000","supplier_name":"Acme"}', '{"total":"120.00000000","supplier_name":"Acme"}')).toEqual([
      { field: 'total', label: 'Total', before: '115', after: '120' },
    ]);
    const summary = parseIndexedSummary('Current invoice INV-101 | Supplier Acme Ltd | Total 120.00000000');
    expect(summary?.heading).toBe('Current invoice INV-101');
    expect(summary?.pairs).toEqual([{ key: 'Supplier', value: 'Acme Ltd' }, { key: 'Total', value: '120' }]);
  });
  it('translates validation issues into plain English and computes visual analytics without mutating decimals', () => {
    const issueInfo = describeValidationIssue({
      code: 'TOTAL_MISMATCH', field: 'total', expected: '115.00', actual: '120.00', severity: 'high',
      manual_review_required: true, related_document_id: null, related_invoice_id: null, evidence: { difference: '5.00' },
    });
    expect(issueInfo.category).toBe('math');
    expect(issueInfo.title).toContain('Grand total');

    const termsOnly = computeValidationAnalytics({
      engine_version: '1', status: 'REVIEW_REQUIRED', currency: 'BDT', minor_units: 2, tolerance: '0.01',
      issues: [{
        code: 'TAX_METHOD_UNIDENTIFIED', field: 'terms.tax_mode', expected: 'Explicit', actual: 'unknown',
        severity: 'medium', manual_review_required: true, related_document_id: null, related_invoice_id: null, evidence: {},
      }],
      checks: [{ code: 'TOTAL_MISMATCH', field: 'total', status: 'skipped', expected: null, actual: null }],
    }, 'BDT');
    expect(termsOnly.needsTermsSetup).toBe(true);
    expect(termsOnly.tone).toBe('info');
    expect(termsOnly.skippedChecks).toBe(1);

    const mismatch = computeValidationAnalytics({
      engine_version: '1', status: 'REVIEW_REQUIRED', currency: 'BDT', minor_units: 2, tolerance: '0.01',
      issues: [{
        code: 'TOTAL_MISMATCH', field: 'total', expected: '115.00', actual: '120.00',
        severity: 'high', manual_review_required: true, related_document_id: null, related_invoice_id: null, evidence: { difference: '5.00' },
      }],
      checks: [
        { code: 'SUBTOTAL_MISMATCH', field: 'subtotal', status: 'passed', expected: '100.00', actual: '100.00' },
        { code: 'TOTAL_MISMATCH', field: 'total', status: 'failed', expected: '115.00', actual: '120.00' },
      ],
    }, 'BDT');
    expect(mismatch.tone).toBe('danger');
    expect(mismatch.scorePct).toBe(50);
    expect(mismatch.largestVariance).toEqual({ field: 'total', difference: '5.00' });

    const invAnalytics = computeInvoiceVisualAnalytics({
      id, document_id: id, candidate_id: null, revision: 1,
      invoice_number: 'INV-1', invoice_date: '2026-10-01', supplier_name: 'Acme', customer_name: 'Buyer',
      subtotal: '100.00000000', tax: '15.00000000', total: '115.00000000', currency: 'USD',
      terms: { tax_mode: 'exclusive', subtotal_basis: 'net', line_amount_basis: 'net', tax_scope: 'reported', charges: '0', discounts: '0', withholding: '0', adjustments_complete: true, line_items_complete: true, excluded_line_item_ids: [], evidence: {} },
      evidence: {}, original_values: {}, source_warnings: [],
      line_items: [
        { id: '22222222-2222-4222-8222-222222222221', line_number: 1, revision: 1, description: 'A', quantity: '1', unit_price: '75', tax_rate: '0.15', line_total: '75', evidence: {}, original_values: {} },
        { id: '22222222-2222-4222-8222-222222222222', line_number: 2, revision: 1, description: 'B', quantity: '1', unit_price: '25', tax_rate: '0.15', line_total: '25', evidence: {}, original_values: {} },
      ],
    });
    expect(invAnalytics.filledCoreFields).toBe(8);
    expect(invAnalytics.completenessPct).toBe(100);
    expect(invAnalytics.composition?.effectiveTaxPct).toBe('15.0%');
    expect(invAnalytics.largestLineId).toBe('22222222-2222-4222-8222-222222222221');
    expect(invAnalytics.lineShares['22222222-2222-4222-8222-222222222221']).toBe(75);
  });
});
