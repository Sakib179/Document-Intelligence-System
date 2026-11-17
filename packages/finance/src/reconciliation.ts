import { financialInvoiceSchema, financialRulesSchema, reconciliationReportSchema } from '@doc/contracts';
import type { FinancialInvoice, FinancialLine, FinancialRules, FinancialIssue, ReconciliationComparison, ReconciliationReport } from '@doc/contracts';
import { FINANCE_ENGINE_VERSION, parseAmount, normalizeIdentity, normalizeSupplier, currencyPolicy, validDate, isCurrency } from './decimal.js';
import { matchingSignals } from './duplicates.js';
import { financialStatus } from './validation.js';
/** One-to-one conservative matching; ties stay explicit and source values are never rewritten. */
export function reconcileInvoices(leftInput: FinancialInvoice[], rightInput: FinancialInvoice[], configuration: Partial<FinancialRules> = {}): ReconciliationReport {
  if (leftInput.length > 100 || rightInput.length > 100)
    throw new Error('RECONCILIATION_INVOICE_LIMIT');
  const left = leftInput.map(invoice => financialInvoiceSchema.parse(invoice)), right = rightInput.map(invoice => financialInvoiceSchema.parse(invoice));
  if ([...left, ...right].reduce((count, invoice) => count + invoice.line_items.length, 0) > 2000)
    throw new Error('RECONCILIATION_LINE_LIMIT');
  const rules = financialRulesSchema.parse(configuration), comparisons: ReconciliationComparison[] = [], pairs: ReconciliationReport['pairs'] = [];
  const issueRows: FinancialIssue[] = [];
  const append = (row: ReconciliationComparison) => {
    comparisons.push(row);
    if (row.code)
      issueRows.push({
        code: row.code, field: row.field, expected: row.expected, actual: row.actual, severity: row.severity ?? 'high', manual_review_required: row.manual_review_required,
        related_document_id: row.right_invoice_id ? right.find(invoice => invoice.id === row.right_invoice_id)?.document_id ?? null : null, related_invoice_id: row.right_invoice_id, evidence: row.evidence
      });
  };
  const compare = (a: FinancialInvoice, b: FinancialInvoice, field: string, expected: string | null, actual: string | null, kind: 'text' | 'supplier' | 'date' | 'currency' | 'money' | 'number', aLine: FinancialLine | null = null, bLine: FinancialLine | null = null, optional = false) => {
    const evidence = {
      left: { document_id: a.document_id, invoice_id: a.id, line_item_id: aLine?.id ?? null, source: aLine?.evidence ?? a.evidence, original_values: aLine?.original_values ?? a.original_values },
      right: { document_id: b.document_id, invoice_id: b.id, line_item_id: bLine?.id ?? null, source: bLine?.evidence ?? b.evidence, original_values: bLine?.original_values ?? b.original_values }
    };
    const base = { left_invoice_id: a.id, right_invoice_id: b.id, left_line_item_id: aLine?.id ?? null, right_line_item_id: bLine?.id ?? null, field, expected, actual, evidence };
    let code: string | null = null, status: ReconciliationComparison['match_status'] = 'matched', severity: ReconciliationComparison['severity'] = null, review = false;
    if (expected === null || actual === null || expected.trim() === '' || actual.trim() === '') {
      if (!(optional && expected === null && actual === null)) {
        code = expected === null && actual === null ? 'MISSING_BOTH_VALUES' : expected === null ? 'MISSING_LEFT_VALUE' : 'MISSING_RIGHT_VALUE';
        status = expected === null ? 'missing_left' : 'missing_right';
        severity = 'high';
        review = true;
      }
    }
    else if (kind === 'money' || kind === 'number') {
      const x = parseAmount(expected), y = parseAmount(actual), policy = currencyPolicy(a.currency, rules);
      if (!x || !y) {
        code = 'INVALID_NUMERIC_STRING';
        status = 'mismatch';
        severity = 'high';
        review = true;
      }
      else if (kind === 'money' && (!policy || a.currency !== b.currency)) {
        code = 'CURRENCY_COMPARISON_UNSAFE';
        status = 'ambiguous';
        severity = 'high';
        review = true;
      }
      else if (!x.eq(y)) {
        if (kind === 'money' && policy && x.minus(y).abs().lte(policy.tolerance)) {
          code = 'ROUNDING_DIFFERENCE';
          severity = 'low';
        }
        else {
          code = 'FIELD_MISMATCH';
          status = 'mismatch';
          severity = 'high';
          review = true;
        }
      }
    }
    else {
      const valid = kind === 'date' ? validDate(expected) && validDate(actual) : kind === 'currency' ? isCurrency(expected) && isCurrency(actual) : true;
      const normalize = kind === 'supplier' ? normalizeSupplier : normalizeIdentity;
      if (!valid) {
        code = kind === 'date' ? 'INVALID_INVOICE_DATE' : 'INVALID_CURRENCY';
        status = 'mismatch';
        severity = 'high';
        review = true;
      }
      else if (normalize(expected) !== normalize(actual)) {
        code = 'FIELD_MISMATCH';
        status = 'mismatch';
        severity = 'high';
        review = true;
      }
    }
    append({ ...base, match_status: status, code, severity, manual_review_required: review });
  };
  const unmatched = (a: FinancialInvoice | null, b: FinancialInvoice | null, field: string, code: string, status: ReconciliationComparison['match_status'], aLine: FinancialLine | null = null, bLine: FinancialLine | null = null, extra: Record<string, unknown> = {}) => {
    append({
      left_invoice_id: a?.id ?? null, right_invoice_id: b?.id ?? null, left_line_item_id: aLine?.id ?? null, right_line_item_id: bLine?.id ?? null, field, match_status: status, code,
      expected: aLine?.description ?? a?.invoice_number ?? null, actual: bLine?.description ?? b?.invoice_number ?? null, severity: 'high', manual_review_required: true,
      evidence: { left: a ? { document_id: a.document_id, source: aLine?.evidence ?? a.evidence, values: aLine ?? a } : null, right: b ? { document_id: b.document_id, source: bLine?.evidence ?? b.evidence, values: bLine ?? b } : null, ...extra }
    });
  };
  const compareLines = (a: FinancialInvoice, b: FinancialInvoice) => {
    const used = new Set<string>(), ambiguousRight = new Set<string>();
    const lineIdentity = (line: FinancialLine) => JSON.stringify([normalizeIdentity(line.description), ...(['quantity', 'unit_price', 'tax_rate', 'line_total'] as const).map(field => parseAmount(line[field])?.toFixed() ?? line[field])]);
    for (const line of a.line_items) {
      const same = b.line_items.filter(other => !used.has(other.id) && normalizeIdentity(line.description) && normalizeIdentity(line.description) === normalizeIdentity(other.description));
      // Exact repeated lines can be compared as a multiset without combining records or losing multiplicity.
      const exact = same.find(other => lineIdentity(other) === lineIdentity(line));
      const selected = exact ?? (same.length === 1 ? same[0] : undefined);
      if (!selected) {
        const ambiguous = same.length > 1;
        for (const other of same)
          ambiguousRight.add(other.id);
        unmatched(a, b, `line_items.${line.line_number}`, ambiguous ? 'AMBIGUOUS_LINE_MATCH' : 'LINE_MISSING_RIGHT', ambiguous ? 'ambiguous' : 'missing_right', line, null, { candidate_right_line_ids: same.map(other => other.id) });
        continue;
      }
      // A unique-description match must also be unique on the left unless exact values established a multiset pair.
      if (!exact && a.line_items.filter(other => normalizeIdentity(other.description) === normalizeIdentity(line.description)).length > 1) {
        ambiguousRight.add(selected.id);
        unmatched(a, b, `line_items.${line.line_number}`, 'AMBIGUOUS_LINE_MATCH', 'ambiguous', line, null, { candidate_right_line_ids: [selected.id] });
        continue;
      }
      used.add(selected.id);
      compare(a, b, `line_items.${line.line_number}.description`, line.description, selected.description, 'text', line, selected);
      for (const field of ['quantity', 'unit_price', 'tax_rate', 'line_total'] as const)
        compare(a, b, `line_items.${line.line_number}.${field}`, line[field], selected[field], field === 'unit_price' || field === 'line_total' ? 'money' : 'number', line, selected, field === 'tax_rate');
    }
    for (const line of b.line_items)
      if (!used.has(line.id))
        unmatched(a, b, `line_items.right.${line.line_number}`, ambiguousRight.has(line.id) ? 'AMBIGUOUS_LINE_MATCH' : 'LINE_MISSING_LEFT', ambiguousRight.has(line.id) ? 'ambiguous' : 'missing_left', null, line);
    if (!a.line_items.length || !b.line_items.length)
      unmatched(a, b, 'line_items', 'LINE_ITEMS_UNAVAILABLE', 'ambiguous');
    if (!a.terms.line_items_complete || !b.terms.line_items_complete)
      unmatched(a, b, 'line_items.coverage', 'LINE_ITEM_COVERAGE_UNCONFIRMED', 'ambiguous');
  };
  const options = left.map(invoice => {
    const candidates = right.map((other, index) => {
      const signals = matchingSignals(invoice, other);
      const eligible = signals.includes('invoice_number') || signals.includes('supplier_name') && signals.length >= 4;
      return { index, score: eligible ? (signals.includes('invoice_number') ? 20 : 0) + (signals.includes('supplier_name') ? 10 : 0) + signals.length : 0 };
    });
    const best = Math.max(0, ...candidates.map(candidate => candidate.score));
    return candidates.filter(candidate => candidate.score === best && best > 0).map(candidate => candidate.index);
  });
  const owners = new Map<number, number[]>();
  options.forEach((choices, index) => choices.forEach(choice => owners.set(choice, [...(owners.get(choice) ?? []), index])));
  const used = new Set<number>(), ambiguousRight = new Set<number>();
  for (const [index, invoice] of left.entries()) {
    const choices = options[index]!;
    if (choices.length === 1 && owners.get(choices[0]!)?.length === 1) {
      const selected = right[choices[0]!]!;
      used.add(choices[0]!);
      pairs.push({ left_invoice_id: invoice.id, right_invoice_id: selected.id, candidate_right_ids: [selected.id], match_status: 'matched' });
      compare(invoice, selected, 'invoice_number', invoice.invoice_number, selected.invoice_number, 'text');
      compare(invoice, selected, 'supplier_name', invoice.supplier_name, selected.supplier_name, 'supplier');
      compare(invoice, selected, 'invoice_date', invoice.invoice_date, selected.invoice_date, 'date');
      compare(invoice, selected, 'currency', invoice.currency, selected.currency, 'currency');
      for (const field of ['subtotal', 'tax', 'total'] as const)
        compare(invoice, selected, field, invoice[field], selected[field], 'money');
      compareLines(invoice, selected);
    }
    else if (choices.length) {
      for (const choice of choices)
        ambiguousRight.add(choice);
      const ids = choices.map(choice => right[choice]!.id);
      pairs.push({ left_invoice_id: invoice.id, right_invoice_id: null, candidate_right_ids: ids, match_status: 'ambiguous' });
      unmatched(invoice, null, 'invoice', 'AMBIGUOUS_INVOICE_MATCH', 'ambiguous', null, null, { candidate_right_invoice_ids: ids });
    }
    else {
      pairs.push({ left_invoice_id: invoice.id, right_invoice_id: null, candidate_right_ids: [], match_status: 'missing_right' });
      unmatched(invoice, null, 'invoice', 'INVOICE_MISSING_RIGHT', 'missing_right');
    }
  }
  for (const [index, invoice] of right.entries())
    if (!used.has(index))
      unmatched(null, invoice, 'invoice', ambiguousRight.has(index) ? 'AMBIGUOUS_INVOICE_MATCH' : 'INVOICE_MISSING_LEFT', ambiguousRight.has(index) ? 'ambiguous' : 'missing_left');
  if (!left.length || !right.length)
    issueRows.push({ code: 'INVOICE_RECORDS_UNAVAILABLE', field: 'invoices', expected: null, actual: null, severity: 'high', manual_review_required: true, related_document_id: null, related_invoice_id: null, evidence: { left_count: left.length, right_count: right.length } });
  return reconciliationReportSchema.parse({ engine_version: FINANCE_ENGINE_VERSION, status: financialStatus(issueRows), issues: issueRows, pairs, comparisons });
}
