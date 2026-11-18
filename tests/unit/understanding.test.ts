import { describe, expect, it } from 'vitest';
import { evaluationCases, page, invoice, sheet, understand, DOCUMENT_ID, RUN_ID } from '../fixtures/understanding.js';
import { UnderstandingEngine } from '../../apps/worker/src/understanding/engine.js';

describe('document classification and conservative invoice grouping', () => {
  it.each(evaluationCases)('$name', (example) => {
    const result = understand(example.records);
    expect(result.documentType).toBe(example.type);
    expect(result.candidates.map((candidate) => candidate.source_pages)).toEqual(example.groups);
    if (example.ranges) expect(result.candidates.map((candidate) => candidate.source_locations.map((source) => source.cell_range))).toEqual(example.ranges);
    expect(result.requiresReview).toBe(example.review);
  });
  it('detects a column-flattened invoice and its matching payment-reference continuation', () => {
    const first = 'Northstar Office Supplies Ltd.\nAddress BangladeshINVOICE\nInvoice No.: INV-2026-1048  Invoice Date: 28 Oct 2026  Due Date: 27 Nov 2026\nItem Code Description Qty Unit Price Line Total\nSubtotal 146,000.00\nTOTAL AMOUNT DUE 155,311.00\nSYNTHETIC TEST DATA - NOT A REAL INVOICE                    Page 1';
    const second = 'DELIVERY, SERVICE AND PAYMENT NOTES\nPayment Reference    INV-2026-1048\nSYNTHETIC TEST DATA - NOT A REAL INVOICE                    Page 2';
    const result = understand([page(1, first), page(2, second)]);
    expect(result.documentType).toBe('invoice');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.source_pages).toEqual([1, 2]);
    expect(understand([page(1, second)]).documentType).toBe('unknown');
    expect(understand([page(1, first), page(2, second.replace('1048', '9999'))]).candidates).toHaveLength(2);
  });
  it('groups a 3-page invoice whose totals appear on an INVOICE CONTINUED page and notes on page 3', () => {
    const p1 = 'Delta Industrial Components (Demo) Ltd.\nWarehouse 7, Chattogram, BangladeshINVOICE\nInvoice No.: INV-2026-1072  Invoice Date: 31 Oct 2026  Due Date: 30 Nov 2026\nCurrency: BDT\nBILL TO    SUPPLIER\nItem Code Description Qty Unit Price (BDT) Line Total (BDT)\nIC-001 Bolts 500 28.00 14,000.00\nSYNTHETIC TEST DATA - NOT A REAL INVOICE                    Page 1';
    const p2 = 'INVOICE CONTINUED\nInvoice INV-2026-1072 - continued line-item and financial details.\nSubtotal 344,100.00\nVAT (15.00%) 51,615.00\nTOTAL AMOUNT DUE 398,215.00\nSYNTHETIC TEST DATA - NOT A REAL INVOICE                    Page 2';
    const p3 = 'DELIVERY, SERVICE AND PAYMENT NOTES\nPayment Reference    INV-2026-1072\nSYNTHETIC TEST DATA - NOT A REAL INVOICE                    Page 3';
    const result = understand([page(1, p1), page(2, p2), page(3, p3)]);
    expect(result.documentType).toBe('invoice');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.source_pages).toEqual([1, 2, 3]);
    expect(result.candidates[0]?.review_reasons).not.toContain('AMBIGUOUS_BOUNDARY');
  });
  it('does not treat invoice correspondence without financial table signals as an invoice', () => {
    expect(understand([page(1, 'Letter\nInvoice No.: INV-42\nInvoice Date: 28 Oct 2026\nPlease confirm this reference.')]).documentType).toBe('unknown');
  });
  it('retains every unknown, blank and failed page', () => {
    const bad = page(3, ''); bad.error_code = 'OCR_TIMEOUT';
    const result = understand([page(1, invoice('A-001')), page(2, ''), bad]);
    expect(result.candidates.flatMap((candidate) => candidate.source_pages)).toEqual([1, 2, 3]);
    expect(result.candidates[2]?.review_reasons).toContain('SOURCE_ERROR');
  });
  it('flags repeated identity with no continuation evidence rather than merging it', () => {
    const result = understand([page(1, invoice('A-001')), page(2, invoice('A-001'))]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.requires_manual_review)).toBe(true);
  });
  it('flags incomplete/missing counters and does not jump over an uncertain page', () => {
    const result = understand([page(1, invoice('A', 'Acme', 'Page 1 of 3')), page(2, ''), page(3, invoice('A', 'Acme', 'Page 3 of 3'))]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.review_reasons).toContain('PAGE_SEQUENCE_INCOMPLETE');
  });
  it('preserves a page containing multiple invoice identifiers as ambiguous', () => {
    const result = understand([page(1, invoice('A') + '\nInvoice No: B')]);
    expect(result.candidates[0]?.document_type).toBe('unknown');
    expect(result.candidates[0]?.review_reasons).toContain('CONFLICTING_PAGE_IDENTITIES');
  });
  it('classifies credit/proforma documents separately from tax invoices', () => {
    expect(understand([page(1, 'PRO FORMA INVOICE\nInvoice No PF-1\nSupplier: Acme')]).documentType).toBe('other_business');
    expect(understand([page(1, 'CREDIT NOTE\nOriginal invoice no A')]).documentType).toBe('other_business');
  });
  it('keeps a receipt title distinct from an invoice-number reference label', () => {
    expect(understand([page(1, 'PAYMENT RECEIPT\nInvoice No: A-100\nMerchant: Example Store\nPaid 100')]).documentType).toBe('receipt');
  });
  it('does not classify a mere mention of invoice in correspondence', () => {
    expect(understand([page(1, 'Dear customer, please find your invoice attached. Thank you.')]).documentType).toBe('unknown');
    expect(understand([page(1, 'Invoice notes for the operations meeting')]).documentType).toBe('unknown');
  });
  it('does not invent a truncated identity from a space-separated invoice identifier', () => {
    for (const id of ['INV 001', 'INV A', 'INV - 001']) {
      expect(understand([page(1, `INVOICE\nInvoice No: ${id}\nSupplier: Acme`)]).candidates[0]?.review_reasons).toContain('UNCERTAIN_INVOICE_IDENTIFIER');
    }
  });
  it('flags bounded spreadsheet signal text while preserving complete source references', () => {
    const result = understand(sheet([['Invoice No', 'Supplier', 'Total', 'Notes'], ['A', 'Acme', '100', 'x'.repeat(5000)]]));
    expect(result.candidates[0]?.review_reasons).toContain('SIGNAL_TEXT_LIMIT');
    expect(result.candidates[0]?.source_locations[0]?.cell_range).toBe('A1:D2');
  });
  it('supports identifier labels on a separate normalized line and Bangla headers', () => {
    expect(understand([page(1, 'INVOICE\nInvoice No:\nA-001\nSupplier: Acme')]).candidates[0]?.requires_manual_review).toBe(false);
    expect(understand([page(1, 'চালান\nচালান নং: ১২৩\nসরবরাহকারী: উদাহরণ')]).documentType).toBe('invoice');
  });
  it('preserves low OCR confidence as a review reason', () => {
    const record = page(1, invoice('A')); record.extraction_method = 'ocr'; record.ocr_confidence = 0.4;
    expect(understand([record]).candidates[0]?.review_reasons).toContain('LOW_OCR_CONFIDENCE');
  });
  it('flags a continuation whose supplier identity cannot be checked', () => {
    const result = understand([page(1, 'INVOICE\nInvoice No A\nPage 1 of 2'), page(2, 'INVOICE\nInvoice No A\nPage 2 of 2')]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.review_reasons).toContain('SUPPLIER_IDENTITY_INCOMPLETE');
  });
  it('groups line items only within a confirmed invoice identity and keeps cell ranges', () => {
    const result = understand(sheet([['Invoice No', 'A-001'], ['Supplier', 'Acme'], ['Description', 'Qty', 'Unit Price', 'Total'], ['Widget', '1', '100', '100'], ['Other', '2', '100', '200']]));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.source_locations[0]?.cell_range).toBe('A1:D5');
    expect(result.candidates[0]?.source_worksheets).toEqual(['Invoices']);
  });
  it('never merges different invoice keys in an Excel line-item table', () => {
    const result = understand(sheet([['Invoice No', 'Supplier', 'Description', 'Qty', 'Total'], ['A', 'Acme', 'Widget', '1', '100'], ['B', 'Acme', 'Other', '1', '200']]));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.source_locations[0]?.row_end)).toEqual([2, 3]);
  });
  it('starts a new invoice for a single-cell header after a preceding worksheet table', () => {
    for (const nextId of ['B', 'A']) {
      const result = understand(sheet([['Invoice No', 'A'], ['Supplier', 'Acme'], ['Description', 'Qty', 'Total'], ['First', '1', '100'],
        [`Invoice No: ${nextId}`], ['Supplier', 'Other Supplier'], ['Description', 'Qty', 'Total'], ['Second', '1', '200']]));
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((candidate) => candidate.source_locations[0]?.cell_range)).toEqual(['A1:C4', 'A5:C8']);
      if (nextId === 'A') expect(result.candidates.every((candidate) => candidate.requires_manual_review)).toBe(true);
    }
  });
  it('keeps a new business header out of the preceding invoice table', () => {
    const result = understand(sheet([['Invoice No', 'A'], ['Description', 'Qty', 'Total'], ['First', '1', '100'], ['PURCHASE ORDER']]));
    expect(result.candidates.map((candidate) => candidate.document_type)).toEqual(['invoice', 'other_business']);
    expect(result.candidates[0]?.source_locations[0]?.row_end).toBe(3);
  });
  it('keeps duplicate ledger records separate and does not join worksheets automatically', () => {
    const rows = [['Invoice No', 'Supplier', 'Total'], ['A', 'Acme', '100'], ['A', 'Acme', '100']];
    const result = understand([...sheet(rows, 'First'), ...sheet(rows, 'Second', 2)]);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.map((candidate) => candidate.source_worksheets)).toEqual([['First'], ['First'], ['Second'], ['Second']]);
  });
  it('reassembles rows split across artifact records and preserves empty worksheets', () => {
    const records = sheet([['Invoice No', 'Supplier', 'Total'], ['A', 'Acme', '100']]);
    const rows = records[1]!;
    if (rows.record_type !== 'worksheet_rows') throw new Error('Bad fixture');
    const result = understand([records[0]!, { ...rows, cells: rows.cells.slice(0, 2) }, { ...rows, cells: rows.cells.slice(2) }]);
    expect(result.documentType).toBe('invoice');
    expect(result.candidates[0]?.source_locations[0]?.cell_range).toBe('A1:C2');
    expect(understand(sheet([])).candidates[0]?.review_reasons).toContain('EMPTY_SOURCE');
    expect(understand(sheet([[null, null]])).candidates).toHaveLength(1);
  });
  it('retains source errors after good spreadsheet rows', () => {
    const records = sheet([['Invoice No', 'Supplier', 'Total'], ['A', 'Acme', '100']]);
    const result = understand([...records, { schema_version: 1, tenant_id: '11111111-1111-4111-8111-111111111111', document_id: DOCUMENT_ID, run_id: RUN_ID, record_type: 'source_error', page_number: 1, error_code: 'WORKSHEET_FAILED' }]);
    expect(result.candidates[0]?.review_reasons).toContain('SOURCE_ERROR');
  });
  it('bounds candidate growth while preserving overflow source rows for manual review', () => {
    const result = understand(sheet([['Invoice No', 'Supplier', 'Total'], ['A', 'Acme', '1'], ['B', 'Acme', '2'], ['C', 'Acme', '3'], ['D', 'Acme', '4']]), 3);
    expect(result.candidates).toHaveLength(3);
    const overflow = result.candidates.at(-1)!;
    expect(overflow.document_type).toBe('unknown');
    expect(overflow.review_reasons).toContain('CANDIDATE_LIMIT_EXCEEDED');
    expect(overflow.source_locations[0]?.row_end).toBe(5);
  });
  it('recognizes snake_case invoice register, line item and tax summary headers across sheets', () => {
    const register = sheet([
      ['invoice_number', 'invoice_date', 'supplier_name', 'currency', 'subtotal', 'vat_amount', 'total_amount'],
      ['INV-2026-1048', '2026-10-28T00:00:00', 'Northstar Ltd', 'BDT', '146000', '10731', '155311'],
      ['INV-2026-1072', '2026-10-31T00:00:00', 'Delta Ltd', 'BDT', '344100', '51615', '398215'],
    ], 'Invoice_Register', 1);
    const items = sheet([
      ['invoice_number', 'supplier_name', 'description', 'quantity', 'unit_price', 'line_total', 'currency'],
      ['INV-2026-1048', 'Northstar Ltd', 'Paper', '40', '2450', '98000', 'BDT'],
      ['INV-2026-1048', 'Northstar Ltd', 'Toner', '8', '4200', '33600', 'BDT'],
    ], 'Line_Items', 2);
    const tax = sheet([
      ['invoice_number', 'currency', 'subtotal', 'vat_amount', 'total_due'],
      ['INV-2026-1048', 'BDT', '146000', '10731', '155311'],
    ], 'Tax_Summary', 3);
    const result = understand([...register, ...items, ...tax]);
    expect(result.documentType).toBe('invoice');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.document_type === 'invoice')).toBe(true);
    expect(result.candidates[0]?.source_worksheets).toEqual(['Invoice_Register', 'Line_Items']);
    expect(result.candidates[0]?.source_locations[1]).toMatchObject({ worksheet_name: 'Line_Items', row_start: 1, row_end: 3 });
  });
  it('produces stable IDs for the same normalized run and rejects foreign/duplicate pages', () => {
    expect(understand([page(1, invoice('A'))]).candidates[0]?.candidate_id).toBe(understand([page(1, invoice('A'))]).candidates[0]?.candidate_id);
    expect(() => understand([page(1, ''), page(1, '')])).toThrow('Repeated understanding page');
    const engine = new UnderstandingEngine(DOCUMENT_ID, RUN_ID);
    expect(() => engine.consume({ ...page(1, ''), document_id: RUN_ID }, { artifact: 'fixture', line: 1 })).toThrow('identity mismatch');
  });
});
