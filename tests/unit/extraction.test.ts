import { expect, it, vi } from 'vitest';
import { invoiceExtractionSchema } from '@doc/contracts';
import { extractionEnvironment, extractionContext, mockInvoice, mockProvider, confidentialPolicy, publicPolicy } from '../fixtures/extraction.js';
import { extractInvoice } from '../../apps/worker/src/extraction/engine.js';
import { groundInvoice, sourceDate, sourceDecimal, sourceCurrency } from '../../apps/worker/src/extraction/grounding.js';
import { ProviderFailure, permitsCloud } from '../../apps/worker/src/extraction/types.js';
import type { CloudPolicy } from '../../apps/worker/src/extraction/types.js';

function hooks(policy: CloudPolicy = publicPolicy) {
  return { policy: vi.fn(async () => policy), before: vi.fn(async () => 'attempt-id'), after: vi.fn(async () => undefined), wait: vi.fn(async (_ms: number) => undefined) };
}
it('requires the common evidence-bearing schema and decimal strings', () => {
  expect(invoiceExtractionSchema.safeParse(mockInvoice()).success).toBe(true);
  const bad = { ...mockInvoice(), total: { ...mockInvoice().total, value: 115 } };
  expect(invoiceExtractionSchema.safeParse(bad).success).toBe(false);
  expect(invoiceExtractionSchema.safeParse({ sql: 'DROP TABLE invoices' }).success).toBe(false);
});
it('grounds every requested header and line-item field without financial arithmetic', () => {
  const result = groundInvoice(mockInvoice(), extractionContext());
  expect(result.issues).toEqual([]);
  expect(result.grounded.total.value).toBe('115'); expect(result.grounded.line_items[0]?.tax_rate.value).toBe('0.15');
});
it('keeps missing values null and never derives a missing total from subtotal/tax', () => {
  const proposal = mockInvoice(); proposal.total = { value: null, raw_value: null, evidence: null };
  expect(groundInvoice(proposal, extractionContext()).grounded.total.value).toBeNull();
});
it('rejects fabricated amounts and preserves the proposed result separately', () => {
  const proposal = mockInvoice(); proposal.total.value = '999';
  const result = groundInvoice(proposal, extractionContext());
  expect(result.grounded.total.value).toBeNull(); expect(proposal.total.value).toBe('999');
  expect(result.issues).toContainEqual({ field: 'total', code: 'NUMBER_NOT_PRINTED_OR_UNSUPPORTED' });
});
it('does not calculate or repair a printed inconsistent total', () => {
  const context = extractionContext(); context.sources[6]!.text = 'Grand Total: 999.00';
  const proposal = mockInvoice(); proposal.total.raw_value = '999.00'; proposal.total.value = '999.00'; proposal.total.evidence!.text = 'Grand Total: 999.00';
  expect(groundInvoice(proposal, context).grounded.total.value).toBe('999');
});
it('rejects wrong source/page/cell references rather than accepting plausible evidence', () => {
  for (const mutate of [(field: ReturnType<typeof mockInvoice>['total']) => { field.evidence!.page = 2; },
    (field: ReturnType<typeof mockInvoice>['total']) => { field.evidence!.cell = 'Z99'; },
    (field: ReturnType<typeof mockInvoice>['total']) => { field.evidence!.source_id = 'invented'; }]) {
    const proposal = mockInvoice(); mutate(proposal.total);
    expect(groundInvoice(proposal, extractionContext()).grounded.total.value).toBeNull();
  }
});
it('requires financial field labels and cannot cite an invoice identifier as a total', () => {
  const context = extractionContext(); context.sources[0]!.text = 'Invoice Number: 115.00';
  const proposal = mockInvoice(); proposal.total.evidence = { source_id: 'source-0', page: 1, worksheet: null, cell: null, text: context.sources[0]!.text }; proposal.total.raw_value = '115.00';
  expect(groundInvoice(proposal, context).grounded.total.value).toBeNull();
});
it('preserves exact large decimals and refuses ambiguous formats or excessive rate precision', () => {
  expect(sourceDecimal('1234567890123456.12345678')).toBe('1234567890123456.12345678');
  expect(sourceDecimal('11,500.00')).toBe('11500'); expect(sourceDecimal('1,500')).toBeNull();
  expect(sourceDecimal('(100.00)')).toBe('-100'); expect(sourceDecimal('15%', true)).toBe('0.15');
  expect(sourceDecimal('0.1234567', true)).toBeNull();
});
it('normalizes only unambiguous dates/currencies', () => {
  expect(sourceDate('15/11/2026')).toBe('2026-11-15'); expect(sourceDate('11/15/2026')).toBe('2026-11-15');
  expect(sourceDate('03/04/2026')).toBeNull(); expect(sourceDate('2026-02-30')).toBeNull();
  expect(sourceDate('15 November 2026')).toBe('2026-11-15');
  for (const symbol of ['$', '£', '¥', 'Rs']) expect(sourceCurrency(symbol)).toBeNull();
  expect(sourceCurrency('USD')).toBe('USD'); expect(sourceCurrency('Bangladeshi taka')).toBe('BDT');
});
it('preserves worksheet and cell anchors', () => {
  const context = extractionContext(); context.sources[6]!.worksheet = 'Ledger'; context.sources[6]!.cell = 'D2';
  const proposal = mockInvoice(context.sources);
  expect(groundInvoice(proposal, context).grounded.total.evidence?.cell).toBe('D2');
});
it('drops unsupported invented line items and reports their missing evidence', () => {
  const proposal = mockInvoice(); for (const field of Object.values(proposal.line_items[0]!)) field.evidence!.source_id = 'invented';
  const result = groundInvoice(proposal, extractionContext());
  expect(result.grounded.line_items).toEqual([]); expect(result.issues.some((issue) => issue.code === 'LINE_ITEM_WITHOUT_EVIDENCE')).toBe(true);
});
it('requires the global switch plus trusted classification or explicit approval', () => {
  expect(permitsCloud(false, publicPolicy)).toBe(false); expect(permitsCloud(true, confidentialPolicy)).toBe(false);
  expect(permitsCloud(true, { ...publicPolicy, classifiedBy: null })).toBe(false);
  expect(permitsCloud(true, publicPolicy)).toBe(true);
  expect(permitsCloud(true, { ...confidentialPolicy, allowed: true, approvedBy: publicPolicy.classifiedBy, approvedAt: publicPolicy.classifiedAt })).toBe(true);
});
it('never calls Gemini for confidential data and uses local Qwen', async () => {
  const gemini = mockProvider('gemini'), local = mockProvider('local_qwen'); gemini.extract = vi.fn(gemini.extract);
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini, local }, hooks(confidentialPolicy));
  expect(gemini.extract).not.toHaveBeenCalled(); expect(result.provider).toBe('local_qwen'); expect(result.fallbackUsed).toBe(false);
});
it('prefers Gemini for approved cloud data and does not call local after success', async () => {
  const local = mockProvider('local_qwen'); local.extract = vi.fn(local.extract);
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: mockProvider('gemini'), local }, hooks());
  expect(result.provider).toBe('gemini'); expect(result.fallbackUsed).toBe(false); expect(local.extract).not.toHaveBeenCalled();
});
it('retries transient errors with bounded exponential backoff before local fallback', async () => {
  const call = vi.fn(async () => { throw new ProviderFailure('PROVIDER_UNAVAILABLE', true); }); const spy = hooks();
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: mockProvider('gemini', call), local: mockProvider('local_qwen') }, spy);
  expect(call).toHaveBeenCalledTimes(3); expect(spy.wait.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
  expect(result.provider).toBe('local_qwen'); expect(result.attempts).toHaveLength(4);
});
it('falls back for schema failures without treating unsupported field evidence as provider failure', async () => {
  const invalid = mockProvider('gemini', async () => ({ text: '{"total":100}', modelVersion: null, usage: {} }));
  expect((await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: invalid, local: mockProvider('local_qwen') }, hooks())).provider).toBe('local_qwen');
  const proposal = mockInvoice(); proposal.currency.value = 'EUR';
  const local = mockProvider('local_qwen'); local.extract = vi.fn(local.extract);
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), {
    gemini: mockProvider('gemini', async () => ({ text: JSON.stringify(proposal), modelVersion: null, usage: {} })), local }, hooks());
  expect(result.provider).toBe('gemini'); expect(result.grounded?.currency.value).toBeNull(); expect(local.extract).not.toHaveBeenCalled();
});
it('fails visibly when both providers fail', async () => {
  const failure = async () => { throw new ProviderFailure('PROVIDER_AUTHENTICATION_FAILED'); };
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: mockProvider('gemini', failure), local: mockProvider('local_qwen', failure) }, hooks());
  expect(result.grounded).toBeNull(); expect(result.errorCode).toBe('PROVIDER_AUTHENTICATION_FAILED'); expect(result.attempts).toHaveLength(2);
});
it('never starts a provider call when durable attempt logging fails', async () => {
  const spy = hooks(); spy.before.mockRejectedValue(new Error('Database unavailable'));
  const provider = mockProvider('gemini'); provider.extract = vi.fn(provider.extract);
  await expect(extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: provider, local: null }, spy)).rejects.toThrow('Database unavailable');
  expect(provider.extract).not.toHaveBeenCalled();
});
it('does not retry a provider after successful inference whose completion log fails', async () => {
  const spy = hooks(); spy.after.mockRejectedValue(new TypeError('Database log failed'));
  const provider = mockProvider('gemini'); provider.extract = vi.fn(provider.extract);
  await expect(extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: provider, local: mockProvider('local_qwen') }, spy)).rejects.toThrow('Database log failed');
  expect(provider.extract).toHaveBeenCalledTimes(1);
});
it('enforces timeouts even if a provider ignores its abort signal', async () => {
  const hang = mockProvider('gemini', async () => new Promise(() => undefined));
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true', LLM_TIMEOUT_MS: '100', LLM_MAX_ATTEMPTS: '1' }),
    { gemini: hang, local: mockProvider('local_qwen') }, hooks());
  expect(result.provider).toBe('local_qwen'); expect(result.attempts[0]?.errorCode).toBe('PROVIDER_TIMEOUT');
});
it('does not violate a rate-limit delay larger than the bounded retry budget', async () => {
  const spy = hooks(), call = vi.fn(async () => { throw new ProviderFailure('PROVIDER_RATE_LIMITED', true, true, 60_000); });
  const result = await extractInvoice(extractionContext(), extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini: mockProvider('gemini', call), local: mockProvider('local_qwen') }, spy);
  expect(result.provider).toBe('local_qwen'); expect(call).toHaveBeenCalledTimes(1); expect(spy.wait).not.toHaveBeenCalled();
});
it('never sends public data to Gemini while the global cloud switch is off', async () => {
  const provider = mockProvider('gemini'); provider.extract = vi.fn(provider.extract);
  await extractInvoice(extractionContext(), extractionEnvironment(), { gemini: provider, local: mockProvider('local_qwen') }, hooks(publicPolicy));
  expect(provider.extract).not.toHaveBeenCalled();
});
it('grounds snake_case Excel financial headers and midnight ISO spreadsheet dates', () => {
  expect(sourceDate('2026-10-28T00:00:00')).toBe('2026-10-28');
  expect(sourceDate('2026-10-28T00:00:00Z')).toBe('2026-10-28');
  const context = {
    candidate_id: '11111111-1111-4111-8111-111111111111',
    digest: 'd',
    warnings: [],
    sources: [
      { id: 'c1', page: 1, worksheet: 'Invoice_Register', cell: 'A2', text: 'INV-2026-1048', context: 'column_header: invoice_number\nrow_label: INV-2026-1048', role: 'table_cell' as const },
      { id: 'c2', page: 1, worksheet: 'Invoice_Register', cell: 'B2', text: '2026-10-28T00:00:00', context: 'column_header: invoice_date\nrow_label: INV-2026-1048', role: 'table_cell' as const },
      { id: 'c3', page: 1, worksheet: 'Invoice_Register', cell: 'I2', text: '146000', context: 'column_header: subtotal\nrow_label: INV-2026-1048', role: 'table_cell' as const },
      { id: 'c4', page: 1, worksheet: 'Invoice_Register', cell: 'M2', text: '10731', context: 'column_header: vat_amount\nrow_label: INV-2026-1048', role: 'table_cell' as const },
      { id: 'c5', page: 1, worksheet: 'Invoice_Register', cell: 'O2', text: '155311', context: 'column_header: total_amount\nrow_label: INV-2026-1048', role: 'table_cell' as const },
    ],
  };
  const proposed = {
    ...mockInvoice(),
    invoice_number: { value: 'INV-2026-1048', raw_value: 'INV-2026-1048', evidence: { source_id: 'c1', page: 1, worksheet: 'Invoice_Register', cell: 'A2', text: 'INV-2026-1048' } },
    invoice_date: { value: '2026-10-28', raw_value: '2026-10-28T00:00:00', evidence: { source_id: 'c2', page: 1, worksheet: 'Invoice_Register', cell: 'B2', text: '2026-10-28T00:00:00' } },
    supplier_name: { value: null, raw_value: null, evidence: null },
    customer_name: { value: null, raw_value: null, evidence: null },
    currency: { value: null, raw_value: null, evidence: null },
    subtotal: { value: '146000', raw_value: '146000', evidence: { source_id: 'c3', page: 1, worksheet: 'Invoice_Register', cell: 'I2', text: '146000' } },
    tax: { value: '10731', raw_value: '10731', evidence: { source_id: 'c4', page: 1, worksheet: 'Invoice_Register', cell: 'M2', text: '10731' } },
    total: { value: '155311', raw_value: '155311', evidence: { source_id: 'c5', page: 1, worksheet: 'Invoice_Register', cell: 'O2', text: '155311' } },
    line_items: [],
  };
  const { grounded, issues } = groundInvoice(proposed, context);
  expect(issues).toEqual([]);
  expect(grounded.invoice_date.value).toBe('2026-10-28');
  expect(grounded.tax.value).toBe('10731');
  expect(grounded.total.value).toBe('155311');
});
it('normalizes unambiguous thousands-grouped decimal strings in provider responses while preserving verbatim raw_value', async () => {
  const ctx = extractionContext();
  ctx.sources[6]!.text = 'Grand Total: 398,215.00';
  const proposal = mockInvoice(ctx.sources);
  proposal.total = { value: '398,215.00', raw_value: '398,215.00', evidence: { source_id: ctx.sources[6]!.id, page: 1, worksheet: null, cell: null, text: 'Grand Total: 398,215.00' } };
  const gemini = mockProvider('gemini', async () => ({ text: JSON.stringify(proposal), modelVersion: 'gemini-test', usage: {} }));
  const local = mockProvider('local_qwen'); local.extract = vi.fn(local.extract);
  const result = await extractInvoice(ctx, extractionEnvironment({ CLOUD_LLM_ENABLED: 'true' }), { gemini, local }, hooks());
  expect(result.provider).toBe('gemini');
  expect(result.grounded?.total.value).toBe('398215');
  expect(result.grounded?.total.raw_value).toBe('398,215.00');
  expect(local.extract).not.toHaveBeenCalled();
});
