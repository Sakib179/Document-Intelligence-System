/** Pure string-based display formatting for financial decimals and structured metadata.
 *  Never converts monetary values through JavaScript Number/parseFloat. */

const ZERO_MINOR = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_MINOR = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const FOUR_MINOR = new Set(['CLF', 'UYW']);

function minorDigits(currency?: string | null): number {
  if (!currency) return 2;
  const code = currency.trim().toUpperCase();
  if (ZERO_MINOR.has(code)) return 0;
  if (THREE_MINOR.has(code)) return 3;
  if (FOUR_MINOR.has(code)) return 4;
  return 2;
}

function addGrouping(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function parsePlainDecimal(raw: string): { sign: string; intPart: string; fracPart: string } | null {
  const trimmed = raw.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const sign = match[1] ?? '';
  const intPart = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  const fracPart = match[3] ?? '';
  return { sign, intPart, fracPart };
}

function roundPlainDecimal(
  parsed: { sign: string; intPart: string; fracPart: string },
  maxDecimals: number,
): { sign: string; intPart: string; fracPart: string } {
  const limit = Math.max(0, maxDecimals);
  if (parsed.fracPart.length <= limit) {
    return {
      sign: parsed.sign,
      intPart: parsed.intPart,
      fracPart: parsed.fracPart.replace(/0+$/, ''),
    };
  }
  const kept = parsed.fracPart.slice(0, limit);
  const nextDigit = parsed.fracPart.charCodeAt(limit) - 48;
  const intDigits = parsed.intPart.split('').map(Number);
  const fracDigits = kept.split('').map(Number);

  if (nextDigit >= 5) {
    let carry = 1;
    for (let i = fracDigits.length - 1; i >= 0 && carry; i--) {
      const sum = fracDigits[i]! + carry;
      fracDigits[i] = sum % 10;
      carry = sum >= 10 ? 1 : 0;
    }
    for (let i = intDigits.length - 1; i >= 0 && carry; i--) {
      const sum = intDigits[i]! + carry;
      intDigits[i] = sum % 10;
      carry = sum >= 10 ? 1 : 0;
    }
    if (carry) intDigits.unshift(1);
  }

  return {
    sign: parsed.sign,
    intPart: intDigits.join(''),
    fracPart: fracDigits.join('').replace(/0+$/, ''),
  };
}

/** Formats a decimal string for display, stripping unnecessary trailing zeros and capping at maxDecimals (default 2). */
export function formatDecimal(raw: string | null | undefined, minDecimals = 0, maxDecimals = 2): string | null {
  if (raw === null || raw === undefined || !raw.trim()) return null;
  const parsed = parsePlainDecimal(raw);
  if (!parsed) return raw;
  const rounded = roundPlainDecimal(parsed, maxDecimals);
  const digits = Math.max(minDecimals, rounded.fracPart.length);
  const frac = rounded.fracPart.padEnd(digits, '0');
  const sign = rounded.intPart === '0' && /^0*$/.test(frac) ? '' : rounded.sign;
  return `${sign}${addGrouping(rounded.intPart)}${frac ? '.' + frac : ''}`;
}

/** Formats a plain decimal string for editable inputs (no thousands commas), removing unnecessary trailing zeros. */
export function formatInputNumber(raw: string | null | undefined, maxDecimals = 2): string {
  if (raw === null || raw === undefined || !raw.trim()) return '';
  const parsed = parsePlainDecimal(raw);
  if (!parsed) return raw;
  const rounded = roundPlainDecimal(parsed, maxDecimals);
  const sign = rounded.intPart === '0' && !rounded.fracPart ? '' : rounded.sign;
  return `${sign}${rounded.intPart}${rounded.fracPart ? '.' + rounded.fracPart : ''}`;
}

export function formatAmount(raw: string | null | undefined, currency?: string | null): string | null {
  const maxDecimals = Math.min(2, minorDigits(currency));
  return formatDecimal(raw, 0, maxDecimals);
}

export function formatQuantity(raw: string | null | undefined): string | null {
  return formatDecimal(raw, 0, 2);
}

/** Converts a normalized fraction string (e.g. "0.150000") to a 2-decimal percentage string ("15.00%") using string shifting only. */
export function formatTaxRate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !raw.trim()) return null;
  const parsed = parsePlainDecimal(raw);
  if (!parsed) return raw;
  const fracPadded = parsed.fracPart.padEnd(2, '0');
  const shiftedInt = (parsed.intPart + fracPadded.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const shiftedFrac = fracPadded.slice(2);
  const rounded = roundPlainDecimal({ sign: parsed.sign, intPart: shiftedInt, fracPart: shiftedFrac }, 2);
  const frac = rounded.fracPart.padEnd(2, '0');
  const sign = rounded.intPart === '0' && /^0*$/.test(frac) ? '' : rounded.sign;
  return `${sign}${addGrouping(rounded.intPart)}.${frac}%`;
}

const FIELD_LABELS: Record<string, string> = {
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  supplier_name: 'Supplier',
  customer_name: 'Customer',
  subtotal: 'Subtotal',
  tax: 'Tax',
  total: 'Total',
  currency: 'Currency',
  description: 'Description',
  quantity: 'Quantity',
  unit_price: 'Unit price',
  tax_rate: 'Tax rate',
  line_total: 'Line total',
  coverage: 'Line item coverage',
  line_items: 'Line items',
  invoice: 'Invoice record',
  invoices: 'Invoice records',
  source: 'Source document',
  duplicates: 'Duplicate scan',
  'document.sha256': 'File fingerprint (SHA-256)',
  'terms.tax_mode': 'Tax method',
  'terms.subtotal_basis': 'Subtotal basis',
  'terms.line_amount_basis': 'Line amount basis',
  'terms.tax_scope': 'Tax scope',
  'terms.charges': 'Additional charges',
  'terms.discounts': 'Discounts',
  'terms.withholding': 'Withholding tax',
  'terms.adjustments_complete': 'Adjustments confirmation',
  'terms.line_items_complete': 'Line item coverage',
  'terms.excluded_line_item_ids': 'Excluded lines',
  'line_items.tax_rate': 'Line tax rates',
  'line_items.coverage': 'Line item coverage',
};

export function formatFieldPath(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const lineRight = /^line_items\.right\.(\d+)(?:\.(.+))?$/.exec(field);
  if (lineRight) {
    const sub = lineRight[2] ? ' · ' + (FIELD_LABELS[lineRight[2]] ?? lineRight[2].replaceAll('_', ' ')) : '';
    return `Right line ${lineRight[1]}${sub}`;
  }
  const lineMatch = /^line_items\.(\d+)(?:\.(.+))?$/.exec(field);
  if (lineMatch) {
    const sub = lineMatch[2] ? ' · ' + (FIELD_LABELS[lineMatch[2]] ?? lineMatch[2].replaceAll('_', ' ')) : '';
    return `Line ${lineMatch[1]}${sub}`;
  }
  return field.replaceAll('.', ' · ').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
}

export function formatComparisonValue(value: string | null, field: string, currency?: string | null): string | null {
  if (value === null) return null;
  if (field.endsWith('tax_rate')) return formatTaxRate(value);
  if (field.endsWith('quantity')) return formatQuantity(value);
  if (/(?:^|\.)(?:subtotal|tax|total|unit_price|line_total)$/.test(field)) return formatAmount(value, currency);
  return value;
}

export function formatReconciliationType(type: string): string {
  if (type === 'pdf_to_pdf') return 'PDF ↔ PDF';
  if (type === 'pdf_to_spreadsheet') return 'PDF ↔ Spreadsheet';
  return type.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
}

export function fileBadge(filename: string): { ext: string; tone: 'pdf' | 'sheet' | 'image' | 'other' } {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = (match?.[1] ?? 'FILE').toUpperCase();
  if (ext === 'PDF') return { ext, tone: 'pdf' };
  if (['XLSX', 'XLS', 'CSV'].includes(ext)) return { ext, tone: 'sheet' };
  if (['PNG', 'JPG', 'JPEG', 'TIF', 'TIFF'].includes(ext)) return { ext, tone: 'image' };
  return { ext: ext.slice(0, 4), tone: 'other' };
}

export function shortId(id: string): string {
  return id.length > 13 ? id.slice(0, 8) + '…' : id;
}

export interface AuditDiffEntry {
  field: string;
  label: string;
  before: string;
  after: string;
}

const AUDIT_IGNORED = new Set(['updated_at', 'created_at', 'revision', 'original_values', 'source_evidence', 'field_evidence', 'extraction_metadata', 'id', 'tenant_id', 'source_document_id', 'document_id', 'invoice_id', 'extraction_run_id', 'source_candidate_id', 'source_page_id', 'source_block_id']);

/** Extracts top-level changed fields between before/after JSON strings without rounding numeric strings. */
export function parseAuditDiff(beforeJson: string | null, afterJson: string | null): AuditDiffEntry[] {
  if (!beforeJson || !afterJson) return [];
  try {
    const before = JSON.parse(beforeJson) as Record<string, unknown>;
    const after = JSON.parse(afterJson) as Record<string, unknown>;
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const diffs: AuditDiffEntry[] = [];
    for (const key of keys) {
      if (AUDIT_IGNORED.has(key)) continue;
      const prev = before[key];
      const next = after[key];
      const prevStr = prev === null || prev === undefined ? '' : typeof prev === 'object' ? JSON.stringify(prev) : String(prev);
      const nextStr = next === null || next === undefined ? '' : typeof next === 'object' ? JSON.stringify(next) : String(next);
      if (prevStr !== nextStr) {
        const formatVal = (val: string) => {
          if (!val) return 'Empty';
          if (['subtotal', 'tax', 'total', 'unit_price', 'line_total'].includes(key)) return formatAmount(val) ?? val;
          if (key === 'quantity') return formatQuantity(val) ?? val;
          if (key === 'tax_rate') return formatTaxRate(val) ?? val;
          return val;
        };
        diffs.push({ field: key, label: formatFieldPath(key), before: formatVal(prevStr), after: formatVal(nextStr) });
      }
    }
    return diffs;
  } catch {
    return [];
  }
}

/** Parses pipe-delimited indexed invoice/line summaries into clean key-value badges when present. */
export function parseIndexedSummary(text: string): { heading: string; pairs: { key: string; value: string }[] } | null {
  if (!text.includes(' | ')) return null;
  const parts = text.split(' | ').map(part => part.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const first = parts[0]!;
  if (!/^(?:Current invoice|Current line)\b/i.test(first)) return null;
  const pairs: { key: string; value: string }[] = [];
  for (const part of parts.slice(1)) {
    const match = /^(Supplier|Customer|Date|Currency|Subtotal|Tax|Total|Description|Quantity|Unit price|Tax rate|Line total)\s+(.+)$/i.exec(part);
    if (!match) return null;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (value !== 'unknown') {
      if (['Subtotal', 'Tax', 'Total', 'Unit price', 'Line total'].includes(key)) value = formatAmount(value) ?? value;
      else if (key === 'Quantity') value = formatQuantity(value) ?? value;
      else if (key === 'Tax rate') value = formatTaxRate(value) ?? value;
    }
    pairs.push({ key, value: value === 'unknown' ? '—' : value });
  }
  return { heading: first, pairs };
}
