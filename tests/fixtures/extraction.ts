import { createHash } from 'node:crypto';
import { parseEnvironment } from '@doc/core';
import type { InvoiceExtraction } from '@doc/contracts';
import type { CloudPolicy, EvidenceSource, ExtractionContext, InvoiceProvider, ProviderName } from '../../apps/worker/src/extraction/types.js';

export function extractionEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  return parseEnvironment({ POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'test_database', POSTGRES_USER: 'test',
    POSTGRES_PASSWORD: 'test-only-password-not-a-secret', POSTGRES_APP_PASSWORD: 'test-only-password-not-a-secret',
    POSTGRES_DISPATCHER_PASSWORD: 'test-only-password-not-a-secret', 
    PROCESSOR_INTERNAL_TOKEN: 'test-only-password-not-a-secret', REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'test-only-password-not-a-secret',
    S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'test-documents', S3_ACCESS_KEY: 'test-only-access-key',
    S3_SECRET_KEY: 'test-only-password-not-a-secret', GEMINI_API_KEY: 'test-only-gemini-api-key-not-real', GEMINI_MODEL: 'gemini-fixture',
    LLM_TIMEOUT_MS: '1000', LLM_RETRY_BASE_MS: '10', LLM_RETRY_MAX_MS: '100', ...overrides });
}
export const confidentialPolicy: CloudPolicy = { classification: 'confidential', classifiedBy: null, classifiedAt: null, allowed: false, approvedBy: null, approvedAt: null };
export const publicPolicy: CloudPolicy = { classification: 'public', classifiedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', classifiedAt: '2026-11-15T00:00:00Z', allowed: false, approvedBy: null, approvedAt: null };
const labels = [
  'Invoice Number: INV-101', 'Invoice Date: 2026-11-15', 'Supplier: Acme Ltd', 'Customer: Example Buyer',
  'Subtotal: 100.00', 'Tax: 15.00', 'Grand Total: 115.00', 'Currency: USD', 'Widget 2 50.00 15% 100.00',
];
export function extractionContext(): ExtractionContext {
  const sources: EvidenceSource[] = labels.map((text, index) => ({ id: 'source-' + index, page: 1, worksheet: null, cell: null, text,
    context: index === 8 ? 'table_header: Description Quantity Unit Price Tax Rate Line Total' : '', role: index === 8 ? 'line_item' : 'document_field' }));
  return { candidate_id: '33333333-3333-4333-8333-333333333333', sources, warnings: [], digest: createHash('sha256').update(JSON.stringify(sources)).digest('hex') };
}
export function mockInvoice(sources = extractionContext().sources): InvoiceExtraction {
  const nullField = () => ({ value: null, raw_value: null, evidence: null });
  const field = (label: RegExp, raw: string, value = raw) => {
    const source = sources.find((entry) => label.test(entry.text) && entry.text.includes(raw))
      ?? sources.find((entry) => label.test(entry.context) && entry.text === raw);
    return source ? { value, raw_value: raw, evidence: { source_id: source.id, page: source.page, text: source.text,
      worksheet: source.worksheet, cell: source.cell } } : nullField();
  };
  const result: InvoiceExtraction = {
    invoice_number: field(/invoice (?:number|no)/i, 'INV-101'), invoice_date: field(/date/i, '2026-11-15'),
    supplier_name: field(/supplier/i, 'Acme Ltd'), customer_name: field(/customer/i, 'Example Buyer'),
    subtotal: field(/subtotal/i, '100.00'), tax: field(/^tax\b|column_header: tax\b/i, '15.00'),
    total: field(/grand total|column_header: total/i, '115.00'), currency: field(/currency/i, 'USD'), line_items: [],
  };
  const itemSource = sources.find((source) => source.role === 'line_item' && /Widget/.test(source.text));
  if (itemSource) {
    const item = (raw: string, value = raw) => ({ value, raw_value: raw, evidence: { source_id: itemSource.id, page: itemSource.page,
      text: itemSource.text, worksheet: itemSource.worksheet, cell: itemSource.cell } });
    result.line_items = [{ description: item('Widget'), quantity: item('2'), unit_price: item('50.00'), tax_rate: item('15%', '0.15'), line_total: item('100.00') }];
  }
  return result;
}
export function mockProvider(name: ProviderName, action?: InvoiceProvider['extract']): InvoiceProvider {
  return { name, model: name === 'gemini' ? 'gemini-fixture' : 'qwen-fixture-instruct', endpointFingerprint: createHash('sha256').update(name).digest('hex'),
    extract: action ?? (async (context) => ({ text: JSON.stringify(mockInvoice(context.sources)), modelVersion: name + '-fixture-v1', usage: { input_tokens: 100, output_tokens: 100 } })) };
}
