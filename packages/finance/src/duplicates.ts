import type { DuplicateContext, DuplicateInvoice, FinancialIssue } from '@doc/contracts';
import { normalizeIdentity, normalizeSupplier, parseAmount, validDate, isCurrency } from './decimal.js';
export function matchingSignals(left: DuplicateInvoice, right: DuplicateInvoice): string[] {
  const signals: string[] = [];
  if (normalizeIdentity(left.invoice_number) && normalizeIdentity(left.invoice_number) === normalizeIdentity(right.invoice_number))
    signals.push('invoice_number');
  if (normalizeSupplier(left.supplier_name) && normalizeSupplier(left.supplier_name) === normalizeSupplier(right.supplier_name))
    signals.push('supplier_name');
  if (validDate(left.invoice_date) && left.invoice_date === right.invoice_date)
    signals.push('invoice_date');
  if (isCurrency(left.currency) && left.currency === right.currency)
    signals.push('currency');
  const a = parseAmount(left.total), b = parseAmount(right.total);
  if (a && b && a.eq(b) && isCurrency(left.currency) && left.currency === right.currency)
    signals.push('total');
  return signals;
}
export function detectDuplicates(invoice: DuplicateInvoice, context: DuplicateContext): FinancialIssue[] {
  const issues: FinancialIssue[] = [];
  for (const document of context.exact_documents)
    if (document.document_id !== invoice.document_id)
      issues.push({
        code: 'EXACT_FILE_DUPLICATE', field: 'document.sha256', expected: null, actual: document.sha256, severity: 'medium', manual_review_required: true,
        related_document_id: document.document_id, related_invoice_id: null, evidence: { sha256: document.sha256 },
      });
  for (const other of context.business_candidates) {
    if (other.id === invoice.id || invoice.candidate_id && invoice.candidate_id === other.candidate_id && invoice.document_id === other.document_id)
      continue;
    const signals = matchingSignals(invoice, other);
    if (!(signals.includes('supplier_name') && signals.includes('invoice_number')) && signals.length < 4)
      continue;
    issues.push({
      code: 'BUSINESS_DUPLICATE_CANDIDATE', field: 'invoice', expected: other.invoice_number, actual: invoice.invoice_number, severity: 'medium', manual_review_required: true,
      related_document_id: other.document_id, related_invoice_id: other.id,
      evidence: { matched_signals: signals, matched_signal_count: signals.length, possible_duplicate: true, other_values: other }
    });
  }
  if (context.truncated)
    issues.push({ code: 'DUPLICATE_SCAN_TRUNCATED', field: 'duplicates', expected: null, actual: null, severity: 'medium', manual_review_required: true, related_document_id: null, related_invoice_id: null, evidence: {} });
  return issues;
}
