import { financialInvoiceSchema, financialRulesSchema, duplicateContextSchema, financialValidationReportSchema } from '@doc/contracts';
import type { FinancialInvoice, FinancialRules, DuplicateContext, FinancialIssue, FinancialCheck, FinancialValidationReport } from '@doc/contracts';
import { Exact, FINANCE_ENGINE_VERSION, parseAmount, currencyPolicy, validDate } from './decimal.js';
import type { Amount } from './decimal.js';
import { detectDuplicates } from './duplicates.js';
export function financialStatus(issues: FinancialIssue[]): FinancialValidationReport['status'] {
  return issues.some(issue => issue.manual_review_required || issue.severity === 'high') ? 'REVIEW_REQUIRED' : issues.length ? 'WARNING' : 'VALID';
}
/** Source amounts are never mutated. Every arithmetic operation uses the private Decimal constructor. */
export function validateInvoice(input: FinancialInvoice, configuration: Partial<FinancialRules> = {}, duplicateInput: Partial<DuplicateContext> = {}): FinancialValidationReport {
  const invoice = financialInvoiceSchema.parse(input), rules = financialRulesSchema.parse(configuration), duplicates = duplicateContextSchema.parse(duplicateInput);
  const issues: FinancialIssue[] = [], checks: FinancialCheck[] = [], terms = invoice.terms, policy = currencyPolicy(invoice.currency, rules);
  const issue = (code: string, field: string, expected: string | null, actual: string | null, severity: FinancialIssue['severity'] = 'high', review = true, evidence: Record<string, unknown> = {}) => {
    issues.push({ code, field, expected, actual, severity, manual_review_required: review, related_document_id: null, related_invoice_id: null, evidence });
  };
  const skipped = (code: string, field: string) => checks.push({ code, field, status: 'skipped', expected: null, actual: null });
  const numeric = (value: string | null, field: string): Amount | null => {
    if (value === null)
      return null;
    const number = parseAmount(value);
    if (!number)
      issue('INVALID_NUMERIC_STRING', field, 'Plain decimal string with at most 16 integer and 8 fractional digits', value);
    else if (number.isNegative() && !number.isZero() && !rules.allow_negative_values)
      issue('NEGATIVE_VALUE_NOT_ALLOWED', field, 'Nonnegative value', value);
    return number;
  };
  const compare = (code: string, field: string, expected: Amount, actual: Amount, source: Record<string, unknown> = {}) => {
    if (!policy) {
      skipped(code, field);
      return;
    }
    const rounded = policy.round(expected), difference = actual.minus(rounded).abs();
    const outcome = difference.isZero() ? 'passed' : difference.lte(policy.tolerance) ? 'warning' : 'failed';
    checks.push({ code, field, status: outcome, expected: policy.format(rounded), actual: actual.toFixed() });
    if (outcome === 'failed')
      issue(code, field, policy.format(rounded), actual.toFixed(), 'high', true, { ...source, difference: difference.toFixed(), tolerance: policy.tolerance.toFixed() });
    if (outcome === 'warning')
      issue('ROUNDING_DIFFERENCE', field, policy.format(rounded), actual.toFixed(), 'low', false, { ...source, difference: difference.toFixed(), tolerance: policy.tolerance.toFixed() });
  };
  for (const field of rules.required_fields)
    if (invoice[field] === null || !invoice[field]!.trim())
      issue('MISSING_MANDATORY_FIELD', field, 'Present source value', invoice[field]);
  if (invoice.invoice_date !== null && !validDate(invoice.invoice_date))
    issue('INVALID_INVOICE_DATE', 'invoice_date', 'Unambiguous ISO date', invoice.invoice_date);
  if (!policy)
    issue(invoice.currency === null ? 'CURRENCY_REQUIRED' : 'INVALID_CURRENCY', 'currency', 'Recognized uppercase ISO 4217 currency code', invoice.currency);
  const subtotal = numeric(invoice.subtotal, 'subtotal'), tax = numeric(invoice.tax, 'tax'), total = numeric(invoice.total, 'total');
  for (const warning of invoice.source_warnings)
    issue('SOURCE_' + warning, 'source', null, null, 'medium');
  const charges = numeric(terms.charges, 'terms.charges'), discounts = numeric(terms.discounts, 'terms.discounts'), withholding = numeric(terms.withholding, 'terms.withholding');
  if (terms.tax_mode === 'unknown')
    issue('TAX_METHOD_UNIDENTIFIED', 'terms.tax_mode', 'Explicit inclusive, exclusive or exempt treatment', 'unknown', 'medium');
  if (terms.subtotal_basis === 'unknown')
    issue('SUBTOTAL_BASIS_UNIDENTIFIED', 'terms.subtotal_basis', 'Explicit net or gross basis', 'unknown', 'medium');
  if (terms.line_amount_basis === 'unknown')
    issue('LINE_AMOUNT_BASIS_UNIDENTIFIED', 'terms.line_amount_basis', 'Explicit net or gross basis', 'unknown', 'medium');
  if (terms.tax_mode === 'exclusive' && terms.subtotal_basis === 'gross')
    issue('TAX_BASIS_CONFLICT', 'terms.subtotal_basis', 'Net subtotal for tax-exclusive treatment', 'gross');
  if (terms.tax_mode === 'exempt' && tax && !tax.isZero())
    issue('EXEMPT_TAX_NONZERO', 'tax', '0', tax.toFixed());
  if (terms.tax_mode === 'inclusive' && terms.subtotal_basis === 'gross' && subtotal && tax && !rules.allow_negative_values && tax.gt(subtotal))
    issue('TAX_EXCEEDS_GROSS_SUBTOTAL', 'tax', subtotal.toFixed(), tax.toFixed());
  if (!terms.adjustments_complete)
    issue('ADJUSTMENTS_UNCONFIRMED', 'terms.adjustments_complete', 'Confirm charges, discounts and withholding, including explicit zero values', 'false', 'medium');
  if (!terms.line_items_complete)
    issue('LINE_ITEM_COVERAGE_UNCONFIRMED', 'terms.line_items_complete', 'Confirm that applicable line items are complete', 'false', 'medium');
  for (const id of terms.excluded_line_item_ids)
    if (!invoice.line_items.some(line => line.id === id))
      issue('UNKNOWN_EXCLUDED_LINE', 'terms.excluded_line_item_ids', id, null);
  const applicable = invoice.line_items.filter(line => !terms.excluded_line_item_ids.includes(line.id));
  if (!applicable.length)
    issue('NO_APPLICABLE_LINE_ITEMS', 'line_items', 'At least one applicable line item', null, 'medium');
  const amounts: {
    reported: Amount | null;
    product: Amount | null;
    rate: Amount | null;
  }[] = [];
  for (const [index, line] of invoice.line_items.entries()) {
    const prefix = `line_items.${index}`;
    for (const field of rules.required_line_fields)
      if (line[field] === null || !line[field]!.trim())
        issue('MISSING_LINE_FIELD', `${prefix}.${field}`, 'Present source value', line[field]);
    const quantity = numeric(line.quantity, `${prefix}.quantity`), price = numeric(line.unit_price, `${prefix}.unit_price`), amount = numeric(line.line_total, `${prefix}.line_total`), rate = numeric(line.tax_rate, `${prefix}.tax_rate`);
    if (quantity?.isZero() && !rules.allow_zero_quantity)
      issue('INVALID_QUANTITY', `${prefix}.quantity`, 'Nonzero quantity', line.quantity);
    if (rate && (rate.lt(0) || rate.gt(1)))
      issue('INVALID_TAX_RATE', `${prefix}.tax_rate`, 'Fraction from 0 to 1', line.tax_rate);
    if (terms.tax_mode === 'exempt' && rate && !rate.isZero())
      issue('EXEMPT_TAX_RATE_NONZERO', `${prefix}.tax_rate`, '0', line.tax_rate);
    const product = quantity && price ? quantity.times(price) : null;
    if (terms.line_amount_basis !== 'unknown' && product && amount)
      compare('LINE_AMOUNT_MISMATCH', `${prefix}.line_total`, product, amount, { line_item_id: line.id, source: line.evidence });
    else {
      skipped('LINE_AMOUNT_MISMATCH', `${prefix}.line_total`);
      if (!quantity || !price || !amount)
        issue('LINE_CALCULATION_INCOMPLETE', `${prefix}.line_total`, 'Quantity, unit price and line amount', line.line_total, 'medium');
    }
    if (!terms.excluded_line_item_ids.includes(line.id))
      amounts.push({ reported: amount, product, rate: rate && rate.gte(0) && rate.lte(1) ? rate : null });
  }
  const subtotalValues: Amount[] = [];
  let subtotalComplete = terms.line_items_complete && amounts.length > 0 && terms.subtotal_basis !== 'unknown' && terms.line_amount_basis !== 'unknown';
  for (const entry of amounts) {
    let amount = rules.sum_rounding === 'round_sum_products' ? entry.product : entry.reported;
    if (!amount) {
      subtotalComplete = false;
      continue;
    }
    if (terms.line_amount_basis !== terms.subtotal_basis) {
      if (!entry.rate) {
        subtotalComplete = false;
        issue('LINE_TAX_RATE_REQUIRED', 'line_items.tax_rate', 'Explicit rates for gross/net conversion', null, 'medium');
        continue;
      }
      amount = terms.line_amount_basis === 'gross' ? amount.div(new Exact(1).plus(entry.rate)) : amount.times(new Exact(1).plus(entry.rate));
      if (rules.sum_rounding === 'sum_reported' && policy)
        amount = policy.round(amount);
    }
    subtotalValues.push(amount);
  }
  if (subtotalComplete && subtotal)
    compare('SUBTOTAL_MISMATCH', 'subtotal', subtotalValues.reduce((sum, amount) => sum.plus(amount), new Exact(0)), subtotal, { line_item_ids: applicable.map(line => line.id) });
  else
    skipped('SUBTOTAL_MISMATCH', 'subtotal');
  if (terms.tax_mode === 'exempt' && tax)
    compare('TAX_MISMATCH', 'tax', new Exact(0), tax);
  else if (terms.tax_scope === 'line_items') {
    const adjustmentTaxUnknown = [charges, discounts, withholding].some(amount => amount && !amount.isZero());
    if (adjustmentTaxUnknown)
      issue('TAX_SCOPE_UNCONFIRMED', 'terms.tax_scope', 'Explicit treatment of taxable adjustments', 'line_items', 'medium');
    const taxReady = terms.line_items_complete && amounts.length > 0 && terms.line_amount_basis !== 'unknown' && terms.tax_mode !== 'unknown' && amounts.every(entry => entry.reported && entry.rate) && !adjustmentTaxUnknown;
    if (taxReady && tax) {
      const expected = amounts.reduce((sum, entry) => {
        const amount = entry.reported!, rate = entry.rate!;
        const lineTax = terms.line_amount_basis === 'gross' ? amount.minus(amount.div(new Exact(1).plus(rate))) : amount.times(rate);
        return sum.plus(rules.tax_rounding === 'per_line' && policy ? policy.round(lineTax) : lineTax);
      }, new Exact(0));
      compare('TAX_MISMATCH', 'tax', expected, tax);
    }
    else {
      skipped('TAX_MISMATCH', 'tax');
      issue('TAX_CALCULATION_INCOMPLETE', 'tax', 'Complete lines, explicit rates, basis and adjustment treatment', invoice.tax, 'medium');
    }
  }
  const totalReady = subtotal && tax && total && charges && discounts && withholding && terms.adjustments_complete && terms.subtotal_basis !== 'unknown' && terms.tax_mode !== 'unknown'
    && !(terms.tax_mode === 'exclusive' && terms.subtotal_basis === 'gross');
  if (totalReady) {
    const taxToAdd = terms.subtotal_basis === 'net' ? tax : new Exact(0);
    compare('TOTAL_MISMATCH', 'total', subtotal.plus(taxToAdd).plus(charges).minus(discounts).minus(withholding), total, { tax_mode: terms.tax_mode, subtotal_basis: terms.subtotal_basis, terms_evidence: terms.evidence });
  }
  else {
    skipped('TOTAL_MISMATCH', 'total');
    issue('TOTAL_CALCULATION_INCOMPLETE', 'total', 'Known basis, subtotal, tax, total and explicit adjustments', invoice.total, 'medium');
  }
  issues.push(...detectDuplicates(invoice, duplicates));
  return financialValidationReportSchema.parse({ engine_version: FINANCE_ENGINE_VERSION, status: financialStatus(issues), currency: invoice.currency, minor_units: policy?.digits ?? null, tolerance: policy?.tolerance.toFixed() ?? null, issues, checks });
}
