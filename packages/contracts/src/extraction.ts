import { z } from 'zod';

export const invoiceEvidenceSchema = z.object({
  source_id: z.string().min(1).max(120), page: z.number().int().positive(), text: z.string().min(1).max(1000),
  worksheet: z.string().max(255).nullable(), cell: z.string().max(32).nullable(),
}).strict();
const field = <T extends z.ZodType>(value: T) => z.object({ value: value.nullable(), raw_value: z.string().min(1).max(1000).nullable(), evidence: invoiceEvidenceSchema.nullable() }).strict();
export const extractedTextFieldSchema = field(z.string().min(1).max(500));
export const extractedDecimalFieldSchema = field(z.string().regex(/^-?\d{1,16}(?:\.\d{1,8})?$/));
export const extractedDateFieldSchema = field(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
export const extractedCurrencyFieldSchema = field(z.string().regex(/^[A-Z]{3}$/));
export const invoiceLineExtractionSchema = z.object({
  description: extractedTextFieldSchema, quantity: extractedDecimalFieldSchema, unit_price: extractedDecimalFieldSchema,
  tax_rate: extractedDecimalFieldSchema, line_total: extractedDecimalFieldSchema,
}).strict();
export const invoiceExtractionSchema = z.object({
  invoice_number: extractedTextFieldSchema, invoice_date: extractedDateFieldSchema, supplier_name: extractedTextFieldSchema,
  customer_name: extractedTextFieldSchema, subtotal: extractedDecimalFieldSchema, tax: extractedDecimalFieldSchema,
  total: extractedDecimalFieldSchema, currency: extractedCurrencyFieldSchema, line_items: z.array(invoiceLineExtractionSchema).max(200),
}).strict();
export const extractionIssueSchema = z.object({ field: z.string().max(120), code: z.string().max(80) }).strict();
export const extractionStoredResultSchema = z.object({
  schema_version: z.literal('invoice-extraction-v1'), proposed: invoiceExtractionSchema, grounded: invoiceExtractionSchema,
  issues: z.array(extractionIssueSchema).max(1100),
}).strict();
export const extractionJobPayloadSchema = z.object({
  schemaVersion: z.literal(1), stage: z.literal('extract'), jobId: z.uuid(), tenantId: z.uuid(), documentId: z.uuid(),
  candidateId: z.uuid(), understandingRunId: z.uuid(),
}).strict();
export const documentPrivacySchema = z.object({
  data_classification: z.enum(['confidential', 'public', 'synthetic']), cloud_processing_allowed: z.boolean(), reason: z.string().trim().min(5).max(1000),
}).strict();
export const extractionStartSchema = z.object({ candidate_id: z.uuid().optional() }).strict();
export const extractionAcceptedSchema = z.object({ document_id: z.uuid(), idempotency_key: z.string(), jobs: z.array(z.object({ id: z.uuid(), candidate_id: z.uuid(), status: z.string() }).strict()) }).strict();
const stringValues = z.record(z.string(), z.string().nullable());
export const extractedInvoiceDtoSchema = z.object({
  id: z.uuid(), review_status: z.string(), invoice_number: z.string().nullable(), invoice_date: z.string().nullable(),
  supplier_name: z.string().nullable(), customer_name: z.string().nullable(), subtotal: z.string().nullable(), tax: z.string().nullable(),
  total: z.string().nullable(), currency: z.string().nullable(), original_values: stringValues,
  line_items: z.array(z.object({ id: z.uuid(), line_number: z.number().int().positive(), description: z.string().nullable(), quantity: z.string().nullable(),
    unit_price: z.string().nullable(), tax_rate: z.string().nullable(), line_total: z.string().nullable(), original_values: stringValues }).strict()),
}).strict();
export const extractionResultsSchema = z.object({ document_id: z.uuid(), configured: z.boolean(), runs: z.array(z.object({
  id: z.uuid(), candidate_id: z.uuid(), status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  provider: z.enum(['gemini', 'local_qwen', 'manual']).nullable(), model_id: z.string().nullable(), model_version: z.string().nullable(), prompt_version: z.string().nullable(),
  processing_time_ms: z.number().int().nonnegative().nullable(), fallback_used: z.boolean(), schema_valid: z.boolean().nullable(),
  error_code: z.string().nullable(), result: extractionStoredResultSchema.nullable(), created_at: z.iso.datetime(),
  attempts: z.array(z.object({ provider: z.enum(['gemini', 'local_qwen']), model_id: z.string(), model_version: z.string().nullable(), prompt_version: z.string(),
    attempt_number: z.number().int(), status: z.enum(['running', 'succeeded', 'failed']), schema_valid: z.boolean().nullable(), error_code: z.string().nullable(),
    processing_time_ms: z.number().int().nonnegative().nullable(), fallback_used: z.boolean() }).strict()),
  invoice: extractedInvoiceDtoSchema.nullable(),
}).strict()), jobs: z.array(z.object({ id: z.uuid(), candidate_id: z.uuid(), status: z.string(), error_code: z.string().nullable() }).strict()), next_cursor: z.string().nullable() }).strict();
export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;
export type ExtractedField = z.infer<typeof extractedTextFieldSchema>;
export type ExtractionIssue = z.infer<typeof extractionIssueSchema>;
export type ExtractionPayload = z.infer<typeof extractionJobPayloadSchema>;
export type ExtractionStoredResult = z.infer<typeof extractionStoredResultSchema>;
