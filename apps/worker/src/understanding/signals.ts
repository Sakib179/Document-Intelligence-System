import type { CandidateEvidence, UnderstoodType } from '@doc/contracts';

export const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const reservedIds = new Set(['date', 'number', 'no', 'id', 'invoice', 'total', 'amount', 'supplier', 'customer', 'n/a', 'na', 'unknown', 'none']);
export function identifier(value: string | null | undefined): string | null {
  const result = normalized(value ?? '').replace(/^[#:\s]+|[,:;\s]+$/g, '');
  return result && result.length <= 64 && !reservedIds.has(result) && /^[\p{L}\p{N}][\p{L}\p{N}./_-]*$/u.test(result) ? result : null;
}

export type PageSignals = {
  kind: UnderstoodType; confidence: number; ids: string[]; references: string[]; supplier: string | null; header: boolean;
  counter: { number: number; total: number | null } | null; continued: boolean; table: string | null;
  reasons: string[]; evidence: CandidateEvidence[]; excerpt: string;
};

export function pageSignals(text: string, pageNumber: number, worksheet: string | null = null): PageSignals {
  const lines = text.normalize('NFKC').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const top = lines.slice(0, 12);
  const invoiceHeader = top.some((line) => /^(?:tax|commercial|sales|vat)\s+invoice\b|^invoice\b(?!\s*(?:no\b|number\b|id\b|date\b))|^(?:কর\s*)?চালান(?:\s|$)/iu.test(line));
  const receiptHeader = top.some((line) => /^(?:(?:sales|payment|cash)\s+)?receipt\b|^cash\s+memo\b|^রসিদ(?:\s|$)/iu.test(line));
  const otherHeader = top.some((line) => /^(?:purchase\s+order|quotation|quote\s*(?:no|#)|delivery\s+note|account\s+statement|credit\s+note|pro\s*forma\s+invoice)\b/iu.test(line));
  const evidence: CandidateEvidence[] = [];
  const add = (signal: string, quote: string) => { if (evidence.length < 24) evidence.push({ signal, quote: quote.slice(0, 240), page_number: pageNumber, worksheet_name: worksheet, cell_reference: null }); };
  const ids = new Set<string>();
  const references = new Set<string>();
  let uncertainIdentifier = false;
  let supplier: string | null = null;
  let counter: PageSignals['counter'] = null;
  let continued = false;
  let table: string | null = null;
  for (const [index, line] of lines.entries()) {
    // Referenced/original invoices in receipts/credit notes are not new identities.
    if (!/\b(?:original|reference|related|against|previous)\b/iu.test(line)) {
      const matches = line.matchAll(/\binvoice\s*(?:no\b\.?|number\b|#|id\b)\s*[:#]?\s*([\p{L}\p{N}][\p{L}\p{N}./_-]*)|চালান\s*(?:নং|নম্বর)\s*[:#]?\s*([\p{L}\p{N}][\p{L}\p{N}./_-]*)/giu);
      for (const match of matches) {
        const id = identifier(match[1] ?? match[2]);
        const trailing = line.slice(match.index! + match[0].length).trim();
        if (trailing && !/^(?:invoice\s+date|due\s+date|date|supplier|customer|total|currency|page|continued)\b/iu.test(trailing)) {
          uncertainIdentifier = true; add('uncertain_identifier', line); continue;
        }
        if (id) { ids.add(id); add('invoice_identifier', match[0]); }
      }
      if (/^invoice\s*(?:no\.?|number|#|id)\s*[:#]?\s*$/iu.test(line)) {
        const id = identifier(lines[index + 1]);
        if (id) { ids.add(id); add('invoice_identifier', line + ' ' + lines[index + 1]); }
      }
      // Continuation/header lines like "Invoice INV-2026-1072 - continued line-item and financial details."
      const inlineIdMatch = /^invoice\s+([\p{L}\p{N}][\p{L}\p{N}./_-]*\d[\p{L}\p{N}./_-]*)(?:\s*[-–—:,]\s*(?:continued|continuation|page|summary|details|line|financial)\b.*)?$/iu.exec(line);
      const inlineId = identifier(inlineIdMatch?.[1]);
      if (inlineId) { ids.add(inlineId); add('invoice_identifier', inlineIdMatch![0]); }
    }
    const name = /^(?:supplier|vendor|seller|issued\s+by|merchant|সরবরাহকারী)\s*[:：]\s*(.{2,160})$/iu.exec(line)?.[1];
    if (name) {
      const value = normalized(name);
      if (supplier && supplier !== value) supplier = '__conflicting_suppliers__';
      else supplier = value;
      add('supplier', line);
    }
    // A payment reference can confirm an adjacent continuation, never start an invoice.
    const reference = /^payment\s+reference\s*[:#]?\s+([\p{L}\p{N}][\p{L}\p{N}./_-]*)$/iu.exec(line);
    const referenceId = identifier(reference?.[1]);
    if (referenceId) { references.add(referenceId); add('payment_reference', line); }
    const numbers = /^(?:page\s*)?(\d{1,4})\s*(?:of|\/)\s*(\d{1,4})$/iu.exec(line)
      ?? /^(?:.*\s{2,})?page\s+(\d{1,4})(?:\s*(?:of|\/)\s*(\d{1,4}))?$/iu.exec(line);
    if (numbers) {
      const number = Number(numbers[1]), total = numbers[2] ? Number(numbers[2]) : null;
      if (number > 0 && (total === null || (total >= number && total <= 10_000))) { counter = { number, total }; add('page_number', line); }
    }
    if (/\b(?:continued|continuation|brought\s+forward|carried\s+forward|c\/f|b\/f)\b|পরবর্তী\s*পৃষ্ঠা/iu.test(line)) {
      continued = true; add('continuation', line);
    }
    if (/\b(?:description|item)\b/iu.test(line) && /\b(?:qty|quantity)\b/iu.test(line) && /\b(?:amount|price|total)\b/iu.test(line)) {
      table = 'description_quantity_amount'; add('line_item_header', line);
    }
  }
  if (!table && lines.some((_, index) => /\b(?:description|item)\b/iu.test(lines.slice(index, index + 3).join(' '))
    && /\b(?:qty|quantity)\b/iu.test(lines.slice(index, index + 3).join(' ')) && /\b(?:amount|price|total)\b/iu.test(lines.slice(index, index + 3).join(' ')))) table = 'description_quantity_amount';
  let kind: UnderstoodType = 'unknown', confidence = 0.25;
  const reasons: string[] = [];
  if (uncertainIdentifier) reasons.push('UNCERTAIN_INVOICE_IDENTIFIER');
  if (otherHeader) { kind = 'other_business'; confidence = 0.94; }
  else if (receiptHeader) { kind = 'receipt'; confidence = 0.94; }
  else if (invoiceHeader && ids.size === 1) { kind = 'invoice'; confidence = 0.96; }
  else if (invoiceHeader && (supplier || /\b(?:subtotal|amount\s+due|total|invoice\s+date)\b/iu.test(text))) { kind = 'invoice'; confidence = 0.78; }
  else if (ids.size === 1 && supplier) { kind = 'invoice'; confidence = 0.86; }
  // PDF reading order can attach the title to an adjacent address column, and multi-page
  // invoices can carry totals on a continuation page while page 1 holds the header and line items.
  else if (ids.size === 1 && /\binvoice\s+date\s*:/iu.test(text) && table
    && (/\b(?:subtotal|grand\s+total|total\s+amount\s+due)\b/iu.test(text)
      || (/\b(?:line\s+total|unit\s+price)\b/iu.test(text) && /\b(?:bill\s+to|due\s+date|currency\s*:|supplier)\b/iu.test(text)))) {
    kind = 'invoice'; confidence = 0.88; add('invoice_layout_signals', 'Invoice identifier, invoice date, financial layout and line-item table');
  }
  if (invoiceHeader) add('invoice_header', top.find((line) => /invoice|চালান/iu.test(line)) ?? '');
  if (receiptHeader) add('receipt_header', top.find((line) => /receipt|memo|রসিদ/iu.test(line)) ?? '');
  if (otherHeader) add('business_header', top.find((line) => /order|quotation|statement|note|forma/iu.test(line)) ?? '');
  if (ids.size > 1 || supplier === '__conflicting_suppliers__' || (invoiceHeader && receiptHeader)) {
    kind = 'unknown'; confidence = 0.3; reasons.push('CONFLICTING_PAGE_IDENTITIES');
  }
  if (kind === 'invoice' && ids.size === 0) reasons.push('MISSING_INVOICE_IDENTIFIER');
  if (kind === 'unknown') reasons.push('UNKNOWN_DOCUMENT_TYPE');
  if (counter && counter.number > 1) reasons.push('CONTINUATION_WITHOUT_CONFIRMED_START');
  return { kind, confidence, ids: [...ids], references: [...references], supplier, header: invoiceHeader || receiptHeader || otherHeader, counter, continued, table,
    reasons, evidence, excerpt: top.slice(0, 3).join('\n').slice(0, 480) };
}

export type ColumnRole = 'invoice_id' | 'supplier' | 'date' | 'total' | 'description' | 'quantity' | 'unit_price' | 'currency';
const aliases: Record<ColumnRole, string[]> = {
  invoice_id: ['invoice', 'invoice no', 'invoice number', 'invoice num', 'invoice id', 'inv no', 'inv number', 'চালান নং', 'চালান নম্বর'],
  supplier: ['supplier', 'supplier name', 'vendor', 'vendor name', 'seller', 'seller name', 'সরবরাহকারী'],
  date: ['date', 'invoice date', 'bill date', 'issue date', 'তারিখ'],
  total: ['total', 'amount', 'invoice total', 'line total', 'amount due', 'total amount', 'grand total', 'total due', 'net total', 'মোট'],
  description: ['description', 'item', 'item description', 'product'],
  quantity: ['qty', 'quantity'],
  unit_price: ['unit price', 'unit rate', 'unit cost', 'rate', 'price'],
  currency: ['currency'],
};
export function columnRole(value: string): ColumnRole | null {
  const key = normalized(value).replace(/[_-]+/g, ' ').replace(/[#:：.]/g, '').replace(/\s+/g, ' ').trim();
  return (Object.keys(aliases) as ColumnRole[]).find((role) => aliases[role].includes(key)) ?? null;
}
