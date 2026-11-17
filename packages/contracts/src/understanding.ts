import { z } from 'zod';

export const understoodTypeSchema = z.enum(['invoice', 'receipt', 'other_business', 'unknown']);
export const candidateSourceSchema = z.object({
  page_number: z.number().int().positive(), source_kind: z.enum(['pdf_page', 'image_frame', 'worksheet', 'csv']),
  worksheet_name: z.string().nullable(), row_start: z.number().int().positive().nullable(), row_end: z.number().int().positive().nullable(),
  cell_range: z.string().nullable(), artifact: z.string(), artifact_line: z.number().int().positive(),
  end_artifact: z.string(), end_artifact_line: z.number().int().positive(),
  signal_truncated: z.boolean().default(false),
  table_header_row: z.number().int().positive().nullable().default(null),
}).strict();
export const candidateEvidenceSchema = z.object({
  signal: z.string().max(80), quote: z.string().max(240), page_number: z.number().int().positive(),
  worksheet_name: z.string().nullable(), cell_reference: z.string().nullable(),
}).strict();
export const advisorSuggestionSchema = z.object({
  proposed_document_type: understoodTypeSchema, same_invoice_as_previous: z.boolean(),
  confidence: z.number().min(0).max(1),
}).strict();
export const invoiceCandidateSchema = z.object({
  candidate_id: z.uuid(), document_id: z.uuid(), document_type: understoodTypeSchema,
  source_pages: z.array(z.number().int().positive()).min(1).max(10_000), source_worksheets: z.array(z.string()).max(10_000),
  source_locations: z.array(candidateSourceSchema).min(1).max(10_000),
  segmentation_confidence: z.number().min(0).max(1), requires_manual_review: z.boolean(), review_reasons: z.array(z.string()).max(40),
  evidence: z.array(candidateEvidenceSchema).max(24),
  advisor_suggestion: advisorSuggestionSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.review_reasons.length > 0 && !value.requires_manual_review) context.addIssue({ code: 'custom', message: 'Review reasons must remain visible' });
  if (value.document_type === 'unknown' && !value.requires_manual_review) context.addIssue({ code: 'custom', message: 'Unknown candidates require review' });
  if (value.source_pages.length !== new Set(value.source_pages).size) context.addIssue({ code: 'custom', message: 'Repeated source page' });
});
export const understandingRunSchema = z.object({
  run_id: z.uuid(), document_id: z.uuid(), source_version: z.number().int().positive(), algorithm_version: z.literal('segmentation-v1'),
  document_type: understoodTypeSchema, segmentation_confidence: z.number().min(0).max(1), requires_manual_review: z.boolean(),
  candidate_count: z.number().int().nonnegative(), invoice_candidate_count: z.number().int().nonnegative(),
  ai_status: z.enum(['disabled', 'not_permitted', 'not_needed', 'advised', 'unavailable', 'budget_exhausted']),
  warnings: z.array(z.string()), created_at: z.iso.datetime(),
}).strict();
export const understandingResponseSchema = z.object({
  document_id: z.uuid(), run: understandingRunSchema.nullable(), candidates: z.array(invoiceCandidateSchema), next_cursor: z.string().nullable(),
}).strict();
export type UnderstoodType = z.infer<typeof understoodTypeSchema>;
export type InvoiceCandidate = z.infer<typeof invoiceCandidateSchema>;
export type CandidateSource = z.infer<typeof candidateSourceSchema>;
export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;
export type AdvisorSuggestion = z.infer<typeof advisorSuggestionSchema>;
