import { randomUUID } from 'node:crypto';
import { financialInvoiceSchema, financialLineSchema, financialTermsSchema } from '@doc/contracts';
import type { FinancialInvoice, FinancialLine } from '@doc/contracts';
export function lineFixture(overrides: Partial<FinancialLine> = {}): FinancialLine {
  return financialLineSchema.parse({
    id: randomUUID(), line_number: 1, revision: 1, description: 'Widget', quantity: '2', unit_price: '50.00', tax_rate: '0.15', line_total: '100.00',
    evidence: { page: 1, text: 'Widget 2 50.00 15% 100.00' }, original_values: { description: 'Widget', quantity: '2', unit_price: '50.00', tax_rate: '0.15', line_total: '100.00' }, ...overrides
  });
}
export function invoiceFixture(overrides: Partial<FinancialInvoice> = {}): FinancialInvoice {
  return financialInvoiceSchema.parse({
    id: randomUUID(), document_id: randomUUID(), candidate_id: randomUUID(), revision: 1,
    invoice_number: 'INV-101', invoice_date: '2026-11-15', supplier_name: 'Acme Ltd', customer_name: 'Example Buyer', subtotal: '100.00', tax: '15.00', total: '115.00', currency: 'USD',
    terms: financialTermsSchema.parse({ tax_mode: 'exclusive', subtotal_basis: 'net', line_amount_basis: 'net', tax_scope: 'line_items', charges: '0', discounts: '0', withholding: '0', adjustments_complete: true, line_items_complete: true }),
    evidence: { page: 1, text: 'Invoice INV-101 Total USD 115.00' }, original_values: { invoice_number: 'INV-101', invoice_date: '2026-11-15', supplier_name: 'Acme Ltd', customer_name: 'Example Buyer', subtotal: '100.00', tax: '15.00', total: '115.00', currency: 'USD' }, line_items: [lineFixture()], ...overrides
  });
}
export function matchingCopy(invoice: FinancialInvoice): FinancialInvoice {
  return invoiceFixture({ ...structuredClone(invoice), id: randomUUID(), document_id: randomUUID(), candidate_id: randomUUID(), line_items: invoice.line_items.map(line => ({ ...structuredClone(line), id: randomUUID() })) });
}
