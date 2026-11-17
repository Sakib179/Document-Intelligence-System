import { z } from 'zod';
export const financialStatusSchema = z.enum(['VALID', 'WARNING', 'REVIEW_REQUIRED']);
const value = z.string().max(1000).nullable();
const evidence = z.record(z.string(), z.unknown());
export const financialTermsSchema = z.object({
  tax_mode: z.enum(['unknown', 'exclusive', 'inclusive', 'exempt']).default('unknown'),
  subtotal_basis: z.enum(['unknown', 'net', 'gross']).default('unknown'),
  line_amount_basis: z.enum(['unknown', 'net', 'gross']).default('unknown'),
  tax_scope: z.enum(['reported', 'line_items']).default('reported'),
  charges: value.default(null), discounts: value.default(null), withholding: value.default(null),
  adjustments_complete: z.boolean().default(false), line_items_complete: z.boolean().default(false),
  excluded_line_item_ids: z.array(z.uuid()).max(1000).default([]),
  evidence: evidence.default({}),
}).strict();
export const financialLineSchema = z.object({
  id: z.uuid(), line_number: z.number().int().positive(), revision: z.number().int().positive(),
  description: value, quantity: value, unit_price: value, tax_rate: value, line_total: value,
  evidence, original_values: z.record(z.string(), value),
}).strict();
export const financialInvoiceSchema = z.object({
  id: z.uuid(), document_id: z.uuid(), candidate_id: z.uuid().nullable(), revision: z.number().int().positive(),
  invoice_number: value, invoice_date: value, supplier_name: value, customer_name: value,
  subtotal: value, tax: value, total: value, currency: value,
  terms: financialTermsSchema, evidence, original_values: z.record(z.string(), value),
  source_warnings: z.array(z.string().max(100)).max(200).default([]),
  line_items: z.array(financialLineSchema).max(1000),
}).strict();
export const mandatoryInvoiceFields = ['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency'] as const;
const nonnegative = z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,8})?$/);
export const financialRulesSchema = z.object({
  required_fields: z.array(z.enum(mandatoryInvoiceFields)).max(8).default(['invoice_number', 'invoice_date', 'supplier_name', 'subtotal', 'tax', 'total', 'currency']),
  required_line_fields: z.array(z.enum(['description', 'quantity', 'unit_price', 'line_total'])).max(4).default(['description', 'quantity', 'unit_price', 'line_total']),
  allow_negative_values: z.boolean().default(false), allow_zero_quantity: z.boolean().default(false),
  rounding_mode: z.enum(['half_up', 'half_even']).default('half_up'),
  sum_rounding: z.enum(['sum_reported', 'round_sum_products']).default('sum_reported'),
  tax_rounding: z.enum(['per_line', 'aggregate']).default('per_line'),
  tolerance_minor_units: nonnegative.default('1'),
  currency_overrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.object({
    minor_units: z.number().int().min(0).max(4).optional(), tolerance_minor_units: nonnegative.optional(),
  }).strict()).default({}),
}).strict();
export const financialIssueSchema = z.object({
  code: z.string().max(100), field: z.string().max(180), expected: value, actual: value,
  severity: z.enum(['low', 'medium', 'high']), manual_review_required: z.boolean(),
  related_document_id: z.uuid().nullable().default(null), related_invoice_id: z.uuid().nullable().default(null),
  evidence: evidence.default({}),
}).strict();
export const financialCheckSchema = z.object({
  code: z.string(), field: z.string(), status: z.enum(['passed', 'warning', 'failed', 'skipped']), expected: value, actual: value,
}).strict();
export const financialValidationReportSchema = z.object({
  engine_version: z.string(), status: financialStatusSchema, currency: value,
  minor_units: z.number().int().nullable(), tolerance: value,
  issues: z.array(financialIssueSchema), checks: z.array(financialCheckSchema),
}).strict();
export const duplicateInvoiceSchema = financialInvoiceSchema.pick({ id: true, document_id: true, candidate_id: true, invoice_number: true, supplier_name: true, invoice_date: true, currency: true, total: true });
export const duplicateContextSchema = z.object({
  exact_documents: z.array(z.object({ document_id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default([]),
  business_candidates: z.array(duplicateInvoiceSchema).max(1001).default([]),
  truncated: z.boolean().default(false),
}).strict();
export const reconciliationComparisonSchema = z.object({
  left_invoice_id: z.uuid().nullable(), right_invoice_id: z.uuid().nullable(),
  left_line_item_id: z.uuid().nullable().default(null), right_line_item_id: z.uuid().nullable().default(null),
  field: z.string(), match_status: z.enum(['matched', 'mismatch', 'missing_left', 'missing_right', 'ambiguous']),
  code: z.string().nullable(), expected: value, actual: value,
  severity: z.enum(['low', 'medium', 'high']).nullable(), manual_review_required: z.boolean(), evidence,
}).strict();
export const reconciliationReportSchema = z.object({
  engine_version: z.string(), status: financialStatusSchema, issues: z.array(financialIssueSchema),
  pairs: z.array(z.object({ left_invoice_id: z.uuid(), right_invoice_id: z.uuid().nullable(), candidate_right_ids: z.array(z.uuid()), match_status: z.enum(['matched', 'ambiguous', 'missing_right']) }).strict()),
  comparisons: z.array(reconciliationComparisonSchema),
}).strict();
export const validationRequestSchema = z.object({ rules: financialRulesSchema.default(() => financialRulesSchema.parse({})) }).strict();
const term = financialTermsSchema.shape;
export const financialTermsPatchSchema = z.object({
  tax_mode: term.tax_mode.removeDefault().optional(), subtotal_basis: term.subtotal_basis.removeDefault().optional(), line_amount_basis: term.line_amount_basis.removeDefault().optional(),
  tax_scope: term.tax_scope.removeDefault().optional(), charges: term.charges.removeDefault().optional(), discounts: term.discounts.removeDefault().optional(), withholding: term.withholding.removeDefault().optional(),
  adjustments_complete: term.adjustments_complete.removeDefault().optional(), line_items_complete: term.line_items_complete.removeDefault().optional(),
  excluded_line_item_ids: term.excluded_line_item_ids.removeDefault().optional(), evidence: term.evidence.removeDefault().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, 'Provide at least one financial term');
export const financialTermsUpdateSchema = z.object({ revision: z.number().int().positive(), reason: z.string().trim().min(5).max(1000), terms: financialTermsPatchSchema }).strict();
export const reconciliationRequestSchema = z.object({ left_document_id: z.uuid(), right_document_id: z.uuid(), rules: financialRulesSchema.default(() => financialRulesSchema.parse({})) }).strict();
export const validationRunSchema = z.object({
  id: z.uuid(), invoice_id: z.uuid(), document_id: z.uuid(), created_at: z.iso.datetime(), status: financialStatusSchema, is_current: z.boolean(),
  rules: financialRulesSchema, input_sha256: z.string(), snapshot: z.object({ invoice: financialInvoiceSchema, duplicates: duplicateContextSchema }).strict(), result: financialValidationReportSchema,
}).strict();
export const reconciliationRunSchema = z.object({
  id: z.uuid(), left_document_id: z.uuid(), right_document_id: z.uuid(), created_at: z.iso.datetime(), processing_status: z.string(), financial_status: financialStatusSchema, is_current: z.boolean(),
  rules: financialRulesSchema, input_sha256: z.string(), snapshot: z.object({ left: z.array(financialInvoiceSchema), right: z.array(financialInvoiceSchema), coverage: evidence }).strict(), result: reconciliationReportSchema,
}).strict();
export type FinancialInvoice = z.infer<typeof financialInvoiceSchema>;
export type FinancialLine = z.infer<typeof financialLineSchema>;
export type FinancialTerms = z.infer<typeof financialTermsSchema>;
export type FinancialTermsPatch = z.infer<typeof financialTermsPatchSchema>;
export type FinancialRules = z.infer<typeof financialRulesSchema>;
export type FinancialIssue = z.infer<typeof financialIssueSchema>;
export type FinancialCheck = z.infer<typeof financialCheckSchema>;
export type FinancialValidationReport = z.infer<typeof financialValidationReportSchema>;
export type DuplicateInvoice = z.infer<typeof duplicateInvoiceSchema>;
export type DuplicateContext = z.infer<typeof duplicateContextSchema>;
export type ReconciliationComparison = z.infer<typeof reconciliationComparisonSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
