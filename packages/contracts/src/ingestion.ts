import { z } from 'zod';

export const DOCUMENT_QUEUES = ['document-queue', 'ocr-queue', 'extraction-queue', 'validation-queue', 'indexing-queue'] as const;
export const queueNameSchema = z.enum(DOCUMENT_QUEUES);
export const documentStatusSchema = z.enum(['uploading', 'uploaded', 'queued', 'processing', 'ingested', 'processed', 'partially_processed', 'needs_review', 'failed', 'rejected', 'cancelled']);
export const inspectionSchema = z.object({
  pageCount: z.number().int().positive(),
  mimeType: z.string().min(1),
  kind: z.enum(['pdf', 'image', 'spreadsheet', 'csv']),
  worksheetNames: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
}).strict();
export const antivirusResultSchema = z.object({
  status: z.enum(['clean', 'not_scanned']), engine: z.literal('clamav').nullable(), scannedAt: z.iso.datetime().nullable(),
}).strict();
export const ingestionPayloadSchema = z.object({
  schemaVersion: z.literal(1), jobId: z.uuid(), tenantId: z.uuid(), documentId: z.uuid(),
  storage: z.object({
    bucket: z.string().min(3).max(63), key: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive(), mimeType: z.string().min(1).max(128),
  }).strict(),
}).strict();
export const documentDtoSchema = z.object({
  id: z.uuid(), uploadBatchId: z.uuid().nullable(), originalFilename: z.string(), mimeType: z.string(),
  fileSizeBytes: z.number().int().nonnegative(), sha256: z.string(), documentType: z.string(),
  pageCount: z.number().int().positive().nullable(), processingStatus: documentStatusSchema,
  duplicateOfDocumentId: z.uuid().nullable(), antivirus: antivirusResultSchema.nullable(),
  createdAt: z.iso.datetime(),
}).strict();
export const uploadAcceptedSchema = z.object({
  batchId: z.uuid(), status: z.literal('accepted'), idempotencyKey: z.string(), replayed: z.boolean(),
  documents: z.array(documentDtoSchema).min(1),
}).strict();
export const documentListSchema = z.object({ documents: z.array(documentDtoSchema), nextCursor: z.string().nullable() }).strict();
export const jobStatusSchema = z.object({
  id: z.uuid(), queue: z.string().nullable(), status: z.string(), dispatchState: z.string(),
  attempts: z.number().int(), maxAttempts: z.number().int(), dispatchFailures: z.number().int(),
  errorCode: z.string().nullable(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
}).strict();
export const processingStatusSchema = z.object({ documentId: z.uuid(), status: documentStatusSchema, jobs: z.array(jobStatusSchema) }).strict();
export type Inspection = z.infer<typeof inspectionSchema>;
export type AntivirusResult = z.infer<typeof antivirusResultSchema>;
export type IngestionPayload = z.infer<typeof ingestionPayloadSchema>;
export type DocumentDto = z.infer<typeof documentDtoSchema>;
export type UploadAccepted = z.infer<typeof uploadAcceptedSchema>;
