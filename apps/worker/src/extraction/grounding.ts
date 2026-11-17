import { Decimal } from 'decimal.js';
import type { ExtractedField, ExtractionIssue, InvoiceExtraction } from '@doc/contracts';
import type { ExtractionContext } from './types.js';

const Exact = Decimal.clone({ precision: 48 });
const currencies = new Set(Intl.supportedValuesOf('currency'));
const norm = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en');

export function sourceDecimal(raw: string, rate = false): string | null {
  let value = raw.trim();
  let percent = false;
  if (rate && value.endsWith('%')) { percent = true; value = value.slice(0, -1).trim(); }
  const accounting = /^\(.*\)$/.test(value);
  if (accounting) value = '-' + value.slice(1, -1);
  // Comma-only forms are ambiguous across locales; never guess decimal separators.
  if (/^-?\d{1,3}(?:,\d{3})+\.\d{1,8}$/.test(value)) value = value.replaceAll(',', '');
  if (!/^-?\d{1,16}(?:\.\d{1,8})?$/.test(value)) return null;
  const decimal = new Exact(value);
  const normalized = percent ? decimal.div(100) : decimal;
  if (rate && (normalized.lt(0) || normalized.gt(1) || normalized.decimalPlaces() > 6)) return null;
  return normalized.toFixed();
}

export function sourceDate(raw: string): string | null {
  const value = raw.trim();
  const isoTimestamp = /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00:00(?:\.0+)?(?:Z|[+-]00:00)?)?$/.exec(value);
  let iso = isoTimestamp?.[1] ?? null;
  const numeric = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(value);
  if (numeric) {
    const a = Number(numeric[1]), b = Number(numeric[2]);
    if (a > 12 && b <= 12) iso = `${numeric[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    else if (b > 12 && a <= 12) iso = `${numeric[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const words = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(value) ?? /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (words) {
    const day = /^\d/.test(words[1]!) ? words[1]! : words[2]!;
    const name = /^\d/.test(words[1]!) ? words[2]! : words[1]!;
    const month = months.indexOf(name.toLowerCase().slice(0, 3)) + 1;
    if (month) iso = `${words[3]}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  if (!iso || Number(iso.slice(0, 4)) < 1) return null;
  const date = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function sourceCurrency(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && currencies.has(code)) return code;
  const explicitNames: Record<string, string> = { 'us dollars': 'USD', 'us dollar': 'USD', 'united states dollars': 'USD',
    'bangladeshi taka': 'BDT', 'euro': 'EUR', 'euros': 'EUR', 'british pound sterling': 'GBP', 'japanese yen': 'JPY', 'chinese yuan': 'CNY' };
  return explicitNames[norm(raw)] ?? null;
}

/** Ground proposals in actual immutable source units. These are evidence checks, not arithmetic approval. */
export function groundInvoice(proposed: InvoiceExtraction, context: ExtractionContext): { grounded: InvoiceExtraction; issues: ExtractionIssue[] } {
  const grounded = structuredClone(proposed), issues: ExtractionIssue[] = [];
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const validate = (field: ExtractedField, path: string) => {
    const reject = (code: string, preserveRaw = false) => {
      issues.push({ field: path, code }); field.value = null;
      if (!preserveRaw) { field.raw_value = null; field.evidence = null; }
    };
    if (field.value === null && field.raw_value === null && field.evidence === null) return;
    if (!field.raw_value || !field.evidence) return reject('FIELD_EVIDENCE_REQUIRED');
    const evidence = field.evidence, source = sources.get(evidence.source_id);
    if (!source || evidence.page !== source.page || evidence.worksheet !== source.worksheet || evidence.cell !== source.cell
      || !source.text.includes(evidence.text) || !evidence.text.includes(field.raw_value)) return reject('EVIDENCE_NOT_SUPPORTED');
    if (field.value === null) { issues.push({ field: path, code: 'UNCERTAIN_SOURCE_VALUE' }); return; }
    if (['subtotal', 'tax', 'total'].includes(path)) {
      const label = path === 'subtotal' ? /\b(?:sub\s*total|net\s+amount)\b/iu : path === 'tax' ? /\b(?:tax|vat|gst)\b|ভ্যাট|কর/iu : /\b(?:grand\s+total|total|amount\s+due|balance\s+due|total\s+due)\b|মোট/iu;
      const ownText = source.text.replaceAll('_', ' ');
      const contextText = source.context.replaceAll('_', ' ');
      const hasOwnLabel = /\b(?:sub\s*total|tax|vat|gst|total|amount\s+due|total\s+due)\b|মোট|ভ্যাট/iu.test(ownText);
      if (source.role === 'line_item' || !label.test(hasOwnLabel ? ownText : contextText)) return reject('FINANCIAL_FIELD_LABEL_UNCERTAIN', true);
    }
    if (path === 'invoice_date') {
      const date = sourceDate(field.raw_value);
      if (!date || date !== field.value) return reject('DATE_AMBIGUOUS_OR_UNSUPPORTED', true);
      field.value = date;
    } else if (path === 'currency') {
      const currency = sourceCurrency(field.raw_value);
      if (!currency || currency !== field.value) return reject('CURRENCY_AMBIGUOUS_OR_UNSUPPORTED', true);
      field.value = currency;
    } else if (['subtotal', 'tax', 'total'].includes(path) || /\.(?:quantity|unit_price|tax_rate|line_total)$/.test(path)) {
      const value = sourceDecimal(field.raw_value, path.endsWith('.tax_rate'));
      if (value === null || !new Exact(value).eq(field.value)) return reject('NUMBER_NOT_PRINTED_OR_UNSUPPORTED', true);
      field.value = new Exact(field.value).toFixed();
    } else {
      if (norm(field.value) !== norm(field.raw_value)) return reject('TEXT_NOT_SUPPORTED', true);
      field.value = field.raw_value;
    }
  };
  for (const name of ['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency'] as const) validate(grounded[name], name);
  grounded.line_items.forEach((line, index) => { for (const name of ['description', 'quantity', 'unit_price', 'tax_rate', 'line_total'] as const) validate(line[name], `line_items.${index}.${name}`); });
  grounded.line_items = grounded.line_items.filter((line, index) => {
    if (Object.values(line).some((field) => field.evidence !== null)) return true;
    issues.push({ field: `line_items.${index}`, code: 'LINE_ITEM_WITHOUT_EVIDENCE' }); return false;
  });
  for (const warning of context.warnings) issues.push({ field: 'document', code: warning });
  if (!Object.values(grounded).some((field) => !Array.isArray(field) && field.value !== null)) issues.push({ field: 'document', code: 'NO_EXTRACTED_HEADER_VALUES' });
  return { grounded, issues };
}
