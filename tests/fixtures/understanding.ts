import type { ProcessingRecord, UnderstoodType } from '@doc/contracts';
import { UnderstandingEngine } from '../../apps/worker/src/understanding/engine.js';

export const DOCUMENT_ID = '33333333-3333-4333-8333-333333333333';
export const RUN_ID = '44444444-4444-4444-8444-444444444444';
const envelope = { schema_version: 1 as const, tenant_id: '11111111-1111-4111-8111-111111111111', document_id: DOCUMENT_ID, run_id: RUN_ID };
export function page(number: number, text: string): ProcessingRecord & { record_type: 'page' } {
  return { ...envelope, record_type: 'page', page_number: number, source_kind: 'pdf_page', extraction_method: 'digital_text', text, blocks: [],
    width: 600, height: 800, coordinate_system: 'pdf_points', ocr_confidence: null, worksheet_name: null, source_reference: { pdf_page: number }, warnings: [], error_code: null };
}
export function sheet(matrix: (string | null)[][], name = 'Invoices', number = 1): ProcessingRecord[] {
  const header: ProcessingRecord = { ...page(number, ''), source_kind: 'worksheet', extraction_method: 'spreadsheet', coordinate_system: 'worksheet', worksheet_name: name, width: null, height: null };
  const cells = matrix.flatMap((row, index) => row.map((value, column) => ({ reference: String.fromCharCode(65 + column) + (index + 1), row: index + 1,
    column: column + 1, value, value_type: value === null ? 'missing' : 'string', formula: null, cached_value: null, source_reference: { worksheet: name } })));
  const records: ProcessingRecord[] = [header];
  for (let offset = 0; offset < cells.length; offset += 500) {
    const batch = cells.slice(offset, offset + 500);
    records.push({ ...envelope, record_type: 'worksheet_rows', page_number: number, worksheet_name: name,
      row_start: batch[0]!.row, row_end: batch.at(-1)!.row, cells: batch });
  }
  return records;
}
export const invoice = (id: string, supplier = 'Acme', footer = '') => `INVOICE\nInvoice No: ${id}\nSupplier: ${supplier}\nDescription Qty Amount\nFixture 1 100\nTotal 100\n${footer}`;
export function understand(records: ProcessingRecord[], limit = 10_000) {
  const engine = new UnderstandingEngine(DOCUMENT_ID, RUN_ID, limit);
  records.forEach((record, index) => engine.consume(record, { artifact: 'normalized/part-00000.jsonl.gz', line: index + 1 }));
  return engine.finish(records.filter((record) => record.record_type === 'page').length);
}
export const evaluationCases: { name: string; records: ProcessingRecord[]; type: UnderstoodType; groups: number[][]; ranges?: (string | null)[][]; review: boolean }[] = [
  { name: 'single_invoice', records: [page(1, invoice('A-001'))], type: 'invoice', groups: [[1]], review: false },
  { name: 'multi_page_invoice', records: [page(1, invoice('A-001', 'Acme', 'Page 1 of 2')), page(2, invoice('A-001', 'Acme', 'Page 2 of 2'))], type: 'invoice', groups: [[1, 2]], review: false },
  { name: 'two_invoices', records: [page(1, invoice('A-001')), page(2, invoice('A-002'))], type: 'invoice', groups: [[1], [2]], review: false },
  { name: 'continued_table', records: [page(1, invoice('A-001', 'Acme', 'Page 1 of 2')), page(2, 'Supplier: Acme\nDescription Qty Amount\nContinued\nPage 2 of 2')], type: 'invoice', groups: [[1, 2]], review: true },
  { name: 'receipt', records: [page(1, 'PAYMENT RECEIPT\nMerchant: Example\nReference invoice no A-001\nPaid 100')], type: 'receipt', groups: [[1]], review: false },
  { name: 'business_document', records: [page(1, 'PURCHASE ORDER\nOrder No PO-123\nSupplier: Acme')], type: 'other_business', groups: [[1]], review: false },
  { name: 'ambiguous_boundary', records: [page(1, invoice('A-001')), page(2, 'Continued\nDescription Qty Amount\nFixture 2 200')], type: 'unknown', groups: [[1], [2]], review: true },
  { name: 'unknown_page', records: [page(1, 'Unlabeled business correspondence')], type: 'unknown', groups: [[1]], review: true },
  { name: 'same_number_different_supplier', records: [page(1, invoice('001', 'Acme')), page(2, invoice('001', 'Other Company'))], type: 'invoice', groups: [[1], [2]], review: false },
  { name: 'page_reset', records: [page(1, invoice('A-001', 'Acme', 'Page 1 of 1')), page(2, invoice('A-001', 'Acme', 'Page 1 of 1'))], type: 'invoice', groups: [[1], [2]], review: false },
  { name: 'excel_invoice_records', records: sheet([['Invoice No', 'Supplier', 'Total'], ['A-001', 'Acme', '100'], ['A-002', 'Acme', '200']]), type: 'invoice', groups: [[1], [1]], ranges: [['A1:C2'], ['A3:C3']], review: false },
  { name: 'excel_missing_identity', records: sheet([['Invoice No', 'Supplier', 'Total'], [null, 'Acme', '100']]), type: 'unknown', groups: [[1]], ranges: [['A1:C2']], review: true },
];
