import type { FinancialCheck, FinancialInvoice, FinancialIssue, FinancialValidationReport } from '@doc/contracts';

const humanizeField = (field: string) => field.replaceAll('.', ' · ').replaceAll('_', ' ');

export type IssueCategory = 'math' | 'terms' | 'data' | 'duplicates';

export interface FriendlyIssueCopy {
  title: string;
  explanation: string;
  action: string;
  category: IssueCategory;
  /** Hide Expected/Found comparison chips when the backend strings are long instructional text instead of values. */
  hideValueCompare?: boolean;
}

export interface FriendlyCheckCopy {
  title: string;
  shortLabel: string;
  detail: string;
}

export const CATEGORY_META: Record<IssueCategory, { label: string; description: string }> = {
  math: { label: 'Math & totals', description: 'Arithmetic verification across line items, subtotal, tax, and grand total' },
  terms: { label: 'Terms setup', description: 'Tax method and billing basis confirmations needed for full verification' },
  data: { label: 'Data quality', description: 'Missing, invalid, or uncertain extracted values' },
  duplicates: { label: 'Duplicate risk', description: 'Matching files or invoices already present in the workspace' },
};

const ISSUE_COPY: Record<string, FriendlyIssueCopy> = {
  LINE_AMOUNT_MISMATCH: {
    title: 'Line total doesn’t match Qty × Unit price',
    explanation: 'Multiplying quantity by unit price gave a different amount than the printed line total.',
    action: 'Compare this row against the original document or correct it in Manual review.',
    category: 'math',
  },
  SUBTOTAL_MISMATCH: {
    title: 'Line items don’t add up to subtotal',
    explanation: 'The sum of applicable line items does not match the invoice subtotal within currency rounding tolerance.',
    action: 'Check for missing/extra line items, discounts, or a misread subtotal value.',
    category: 'math',
  },
  TAX_MISMATCH: {
    title: 'Reported tax doesn’t match calculated tax',
    explanation: 'The invoice tax amount differs from the tax calculated from the line items or tax method.',
    action: 'Verify tax rates, tax-exempt items, or switch tax scope in Confirm terms.',
    category: 'math',
  },
  TOTAL_MISMATCH: {
    title: 'Grand total doesn’t match subtotal + tax',
    explanation: 'Combining subtotal, tax, charges, discounts, and withholding does not equal the printed grand total.',
    action: 'Check for unrecorded discounts, shipping/charges, withholding tax, or a source typo.',
    category: 'math',
  },
  ROUNDING_DIFFERENCE: {
    title: 'Minor rounding difference (within tolerance)',
    explanation: 'The calculated figure differs slightly from the printed value, within the allowed rounding tolerance.',
    action: 'No action required unless strict zero-cent reconciliation is needed.',
    category: 'math',
  },
  LINE_CALCULATION_INCOMPLETE: {
    title: 'Line math couldn’t be verified',
    explanation: 'Quantity, unit price, or line total is missing on this row, so the line calculation was skipped.',
    action: 'Fill in missing row values in Manual review if they appear on the source document.',
    category: 'math',
    hideValueCompare: true,
  },
  TAX_CALCULATION_INCOMPLETE: {
    title: 'Line-item tax check couldn’t run',
    explanation: 'Some line items are missing amounts or tax rates needed to compute total tax from lines.',
    action: 'Add missing tax rates or verify against Reported header tax in Confirm terms.',
    category: 'math',
    hideValueCompare: true,
  },
  TOTAL_CALCULATION_INCOMPLETE: {
    title: 'Grand total check paused',
    explanation: 'Full total verification requires confirmed tax treatment, billing basis, and adjustments (charges/discounts).',
    action: 'Click Confirm terms above to unlock grand total math verification.',
    category: 'terms',
    hideValueCompare: true,
  },
  EXEMPT_TAX_NONZERO: {
    title: 'Tax-exempt invoice has non-zero tax',
    explanation: 'Tax method is set to Exempt, but the extracted tax amount is greater than zero.',
    action: 'Change tax method to Exclusive/Inclusive or verify the tax field against the source.',
    category: 'math',
  },
  EXEMPT_TAX_RATE_NONZERO: {
    title: 'Tax-exempt invoice has non-zero line tax rate',
    explanation: 'Tax method is Exempt, yet a line item carries a non-zero tax rate.',
    action: 'Review the line tax rate or update the invoice tax method.',
    category: 'math',
  },
  TAX_EXCEEDS_GROSS_SUBTOTAL: {
    title: 'Tax exceeds gross subtotal',
    explanation: 'Extracted tax is larger than the gross subtotal, which is mathematically inconsistent.',
    action: 'Check whether subtotal and tax values were swapped or misread.',
    category: 'math',
  },
  TAX_METHOD_UNIDENTIFIED: {
    title: 'Tax method needs confirmation',
    explanation: 'The system never guesses whether prices exclude tax, include tax, or are tax-exempt.',
    action: 'Open Confirm terms and choose Exclusive, Inclusive, or Exempt.',
    category: 'terms',
    hideValueCompare: true,
  },
  SUBTOTAL_BASIS_UNIDENTIFIED: {
    title: 'Subtotal basis (Net vs Gross) not confirmed',
    explanation: 'Confirm whether the printed subtotal is before tax (Net) or already includes tax (Gross).',
    action: 'Set Subtotal basis in Confirm terms so total verification can run.',
    category: 'terms',
    hideValueCompare: true,
  },
  LINE_AMOUNT_BASIS_UNIDENTIFIED: {
    title: 'Line item basis (Net vs Gross) not confirmed',
    explanation: 'Confirm whether each line total is before tax (Net) or includes tax (Gross).',
    action: 'Set Line item basis in Confirm terms so line and subtotal math checks can run.',
    category: 'terms',
    hideValueCompare: true,
  },
  ADJUSTMENTS_UNCONFIRMED: {
    title: 'Charges, discounts & withholding unconfirmed',
    explanation: 'Confirm whether any extra fees, discounts, or withholding taxes apply (even if zero).',
    action: 'Check "Charges, discounts & withholding confirmed complete" in Confirm terms.',
    category: 'terms',
    hideValueCompare: true,
  },
  LINE_ITEM_COVERAGE_UNCONFIRMED: {
    title: 'Line item completeness not confirmed',
    explanation: 'Confirm that all applicable invoice rows were captured before summing them against the subtotal.',
    action: 'Check "All applicable line items are present" in Confirm terms.',
    category: 'terms',
    hideValueCompare: true,
  },
  TAX_BASIS_CONFLICT: {
    title: 'Conflicting tax method and subtotal basis',
    explanation: 'Tax-exclusive invoices cannot use a Gross subtotal basis.',
    action: 'Set Subtotal basis to Net (or switch Tax method to Inclusive) in Confirm terms.',
    category: 'terms',
  },
  TAX_SCOPE_UNCONFIRMED: {
    title: 'Taxable adjustments need explicit scope',
    explanation: 'Line-item tax verification cannot assume whether extra charges or discounts are taxed.',
    action: 'Verify tax scope or switch to Reported header tax in Confirm terms.',
    category: 'terms',
    hideValueCompare: true,
  },
  LINE_TAX_RATE_REQUIRED: {
    title: 'Line tax rates needed to convert Net ↔ Gross',
    explanation: 'Line items and subtotal use different bases, so every line needs an explicit tax rate to convert.',
    action: 'Enter line tax rates in Manual review or align the line and subtotal bases.',
    category: 'terms',
    hideValueCompare: true,
  },
  UNKNOWN_EXCLUDED_LINE: {
    title: 'Excluded line item no longer exists',
    explanation: 'A line item marked as excluded could not be found on the current invoice revision.',
    action: 'Re-confirm terms to clear stale line exclusions.',
    category: 'terms',
    hideValueCompare: true,
  },
  MISSING_MANDATORY_FIELD: {
    title: 'Required invoice field is missing',
    explanation: 'This mandatory field was not found or could not be grounded to verbatim source text.',
    action: 'Check the original document and fill in the verified value in Manual review.',
    category: 'data',
    hideValueCompare: true,
  },
  MISSING_LINE_FIELD: {
    title: 'Required line-item field is missing',
    explanation: 'A mandatory value (description, quantity, unit price, or line total) is missing on this row.',
    action: 'Inspect the original table and complete the missing cell in Manual review.',
    category: 'data',
    hideValueCompare: true,
  },
  NO_APPLICABLE_LINE_ITEMS: {
    title: 'No line items available for math checks',
    explanation: 'No extracted line items are present to cross-check against the invoice subtotal.',
    action: 'Inspect the source document or re-run extraction with Gemini if line items exist.',
    category: 'data',
    hideValueCompare: true,
  },
  INVALID_INVOICE_DATE: {
    title: 'Invoice date is invalid or ambiguous',
    explanation: 'The extracted date could not be parsed as an unambiguous calendar date (YYYY-MM-DD).',
    action: 'Verify the exact date on the source and enter it in Manual review.',
    category: 'data',
  },
  CURRENCY_REQUIRED: {
    title: 'Currency not identified',
    explanation: 'No explicit ISO currency code (like USD, BDT, EUR) was found; bare symbols like $ are not guessed.',
    action: 'Enter the 3-letter ISO currency code in Manual review to enable rounding tolerances.',
    category: 'data',
    hideValueCompare: true,
  },
  INVALID_CURRENCY: {
    title: 'Unrecognized currency code',
    explanation: 'The currency value is not a valid 3-letter ISO 4217 currency code.',
    action: 'Correct the currency code (for example USD, BDT, EUR, GBP) in Manual review.',
    category: 'data',
  },
  INVALID_NUMERIC_STRING: {
    title: 'Amount format is invalid',
    explanation: 'The extracted value is not a plain decimal number and cannot be used in exact arithmetic.',
    action: 'Correct the amount in Manual review using digits and a decimal point.',
    category: 'data',
  },
  NEGATIVE_VALUE_NOT_ALLOWED: {
    title: 'Negative amount flagged for review',
    explanation: 'A negative monetary amount or quantity was found where standard rules expect a non-negative value.',
    action: 'Verify whether this is a credit note, discount, or extraction error.',
    category: 'data',
  },
  INVALID_QUANTITY: {
    title: 'Zero quantity flagged',
    explanation: 'A line item has a quantity of 0 under rules requiring positive quantities.',
    action: 'Confirm the quantity against the original document in Manual review.',
    category: 'data',
  },
  INVALID_TAX_RATE: {
    title: 'Tax rate is out of range',
    explanation: 'Tax rates must be stored as a fraction between 0 and 1 (for example 0.15 for 15%).',
    action: 'Fix the line tax rate in Manual review.',
    category: 'data',
  },
  EXACT_FILE_DUPLICATE: {
    title: 'Exact duplicate file uploaded',
    explanation: 'Another document in this workspace has the exact same file fingerprint (SHA-256).',
    action: 'Check whether this invoice was already processed to avoid duplicate payment.',
    category: 'duplicates',
    hideValueCompare: true,
  },
  BUSINESS_DUPLICATE_CANDIDATE: {
    title: 'Possible duplicate invoice detected',
    explanation: 'Another invoice in this workspace shares the same invoice number, supplier, date, or total.',
    action: 'Compare against the existing invoice before approving for payment.',
    category: 'duplicates',
  },
  DUPLICATE_SCAN_TRUNCATED: {
    title: 'Duplicate scan reached candidate limit',
    explanation: 'Too many matching records existed to scan exhaustively in one pass.',
    action: 'Search by invoice number and supplier on the Search page to verify uniqueness.',
    category: 'duplicates',
    hideValueCompare: true,
  },
};

export function describeValidationIssue(issue: FinancialIssue): FriendlyIssueCopy {
  const known = ISSUE_COPY[issue.code];
  if (known) return known;
  if (issue.code.startsWith('SOURCE_')) {
    const clean = issue.code.slice('SOURCE_'.length).replaceAll('_', ' ').toLowerCase();
    return {
      title: 'Source document warning: ' + clean,
      explanation: 'A structural or extraction warning was recorded while reading the original document.',
      action: 'Double-check extracted figures against the Original source preview.',
      category: 'data',
      hideValueCompare: true,
    };
  }
  const readable = issue.code.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
  return {
    title: readable,
    explanation: `Requires manual verification on ${humanizeField(issue.field).toLowerCase()}.`,
    action: 'Inspect this field against the original source preview.',
    category: 'data',
  };
}

export function describeCheck(check: FinancialCheck): FriendlyCheckCopy {
  if (check.code === 'LINE_AMOUNT_MISMATCH') {
    const lineMatch = /^line_items\.(\d+)/.exec(check.field);
    const num = lineMatch ? Number(lineMatch[1]) + 1 : null;
    return {
      title: num ? `Line ${num} math (Qty × Price)` : 'Line item math',
      shortLabel: num ? `Line ${num}` : 'Line math',
      detail: 'Quantity × unit price compared with printed line total',
    };
  }
  if (check.code === 'SUBTOTAL_MISMATCH') {
    return {
      title: 'Subtotal vs. sum of lines',
      shortLabel: 'Subtotal sum',
      detail: 'Sum of all applicable line items compared with header subtotal',
    };
  }
  if (check.code === 'TAX_MISMATCH') {
    return {
      title: 'Tax verification',
      shortLabel: 'Tax check',
      detail: 'Calculated tax compared with printed header tax',
    };
  }
  if (check.code === 'TOTAL_MISMATCH') {
    return {
      title: 'Grand total equation',
      shortLabel: 'Grand total',
      detail: 'Subtotal + tax + charges − discounts − withholding vs. printed total',
    };
  }
  const readable = check.code.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
  return { title: readable, shortLabel: readable, detail: humanizeField(check.field) };
}

/** Parses a plain non-negative decimal string into a finite display number ONLY for visual chart proportions (bars/rings). Never used for financial calculations. */
function visualRatioNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface InvoiceVisualAnalytics {
  filledCoreFields: number;
  totalCoreFields: number;
  completenessPct: number;
  composition: {
    subtotalPct: number;
    taxPct: number;
    effectiveTaxPct: string | null;
  } | null;
  lineShares: Record<string, number>;
  largestLineId: string | null;
}

const CORE_FIELDS = ['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency'] as const;

export function computeInvoiceVisualAnalytics(invoice: FinancialInvoice): InvoiceVisualAnalytics {
  const filledCoreFields = CORE_FIELDS.filter(key => invoice[key] !== null && invoice[key]!.trim() !== '').length;
  const totalCoreFields = CORE_FIELDS.length;
  const completenessPct = Math.round((filledCoreFields / totalCoreFields) * 100);

  const subNum = visualRatioNumber(invoice.subtotal);
  const taxNum = visualRatioNumber(invoice.tax);
  let composition: InvoiceVisualAnalytics['composition'] = null;
  if (subNum !== null && taxNum !== null && subNum + taxNum > 0) {
    const sum = subNum + taxNum;
    const subtotalPct = Math.round((subNum / sum) * 1000) / 10;
    const taxPct = Math.round((taxNum / sum) * 1000) / 10;
    const effectiveTaxPct = subNum > 0 ? ((taxNum / subNum) * 100).toFixed(1) + '%' : null;
    composition = { subtotalPct, taxPct, effectiveTaxPct };
  }

  const lineValues = invoice.line_items.map(line => ({ id: line.id, val: visualRatioNumber(line.line_total) ?? 0 }));
  const lineSum = lineValues.reduce((acc, item) => acc + item.val, 0);
  const lineShares: Record<string, number> = {};
  let largestLineId: string | null = null;
  let largestVal = 0;
  if (lineSum > 0) {
    for (const item of lineValues) {
      if (item.val > 0) {
        lineShares[item.id] = Math.round((item.val / lineSum) * 1000) / 10;
        if (item.val > largestVal) {
          largestVal = item.val;
          largestLineId = item.id;
        }
      }
    }
  }

  return { filledCoreFields, totalCoreFields, completenessPct, composition, lineShares, largestLineId };
}

export interface ValidationAnalytics {
  totalChecks: number;
  passedChecks: number;
  warningChecks: number;
  failedChecks: number;
  skippedChecks: number;
  evaluatedChecks: number;
  scorePct: number;
  tone: 'good' | 'warn' | 'danger' | 'info';
  headline: string;
  subline: string;
  needsTermsSetup: boolean;
  categoryCounts: Record<IssueCategory, number>;
  severityCounts: { high: number; medium: number; low: number };
  largestVariance: { field: string; difference: string } | null;
}

export function computeValidationAnalytics(report: FinancialValidationReport, currency?: string | null): ValidationAnalytics {
  const passedChecks = report.checks.filter(c => c.status === 'passed').length;
  const warningChecks = report.checks.filter(c => c.status === 'warning').length;
  const failedChecks = report.checks.filter(c => c.status === 'failed').length;
  const skippedChecks = report.checks.filter(c => c.status === 'skipped').length;
  const totalChecks = report.checks.length;
  const evaluatedChecks = passedChecks + warningChecks + failedChecks;

  const categoryCounts: Record<IssueCategory, number> = { math: 0, terms: 0, data: 0, duplicates: 0 };
  const severityCounts = { high: 0, medium: 0, low: 0 };
  let largestVariance: { field: string; difference: string } | null = null;
  let largestDiffNumeric = -1;

  for (const issue of report.issues) {
    const info = describeValidationIssue(issue);
    categoryCounts[info.category]++;
    severityCounts[issue.severity]++;
    const diffRaw = typeof issue.evidence?.difference === 'string' ? issue.evidence.difference : null;
    if (diffRaw) {
      const n = visualRatioNumber(diffRaw);
      if (n !== null && n > largestDiffNumeric) {
        largestDiffNumeric = n;
        largestVariance = { field: issue.field, difference: diffRaw };
      }
    }
  }

  const needsTermsSetup = categoryCounts.terms > 0;
  let scorePct = 100;
  if (report.status === 'VALID' && report.issues.length === 0) {
    scorePct = 100;
  } else if (evaluatedChecks > 0) {
    scorePct = Math.round(((passedChecks + warningChecks * 0.7) / evaluatedChecks) * 100);
  } else if (totalChecks > 0) {
    scorePct = 0;
  } else {
    scorePct = report.issues.length === 0 ? 100 : 0;
  }

  let tone: ValidationAnalytics['tone'] = 'good';
  let headline = 'All financial checks passed';
  let subline = 'Extracted line items, subtotal, tax, and grand total reconcile cleanly.';

  if (failedChecks > 0 || categoryCounts.math > 0 && severityCounts.high > 0) {
    tone = 'danger';
    const mathFails = failedChecks || categoryCounts.math;
    headline = `${mathFails} arithmetic mismatch${mathFails === 1 ? '' : 'es'} detected`;
    subline = largestVariance
      ? `Largest discrepancy is ${largestVariance.difference}${currency ? ' ' + currency : ''} on ${humanizeField(largestVariance.field)}. Review against the original source.`
      : 'One or more printed amounts disagree with deterministic calculations.';
  } else if (categoryCounts.duplicates > 0) {
    tone = 'warn';
    headline = 'Potential duplicate flagged';
    subline = 'This invoice matches an existing file or invoice record in your workspace.';
  } else if (needsTermsSetup && evaluatedChecks === 0) {
    tone = 'info';
    headline = 'Confirm tax terms to run math checks';
    subline = `${skippedChecks} arithmetic check${skippedChecks === 1 ? ' is' : 's are'} paused until tax treatment (Exclusive/Inclusive) and adjustments are confirmed.`;
  } else if (report.issues.length > 0) {
    tone = severityCounts.high > 0 ? 'danger' : 'warn';
    headline = severityCounts.high > 0
      ? `${severityCounts.high} item${severityCounts.high === 1 ? '' : 's'} need manual review`
      : `${report.issues.length} item${report.issues.length === 1 ? '' : 's'} flagged for review`;
    subline = categoryCounts.data > 0
      ? 'Some required fields or source values need verification against the original document.'
      : 'Minor rounding or confirmation items remain before final sign-off.';
  }

  return {
    totalChecks,
    passedChecks,
    warningChecks,
    failedChecks,
    skippedChecks,
    evaluatedChecks,
    scorePct,
    tone,
    headline,
    subline,
    needsTermsSetup,
    categoryCounts,
    severityCounts,
    largestVariance,
  };
}
