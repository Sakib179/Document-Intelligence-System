import { z } from 'zod';

const sourceSchema = z.object({
  bucket: z.string().min(3).max(63), key: z.string().max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().positive(), extension: z.enum(['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.xlsx', '.xls', '.csv']),
}).strict();
export const processingManifestSchema = z.object({
  schema_version: z.literal(1), processor_version: z.literal('document-v1'), tenant_id: z.uuid(), document_id: z.uuid(), run_id: z.uuid(),
  document_type: z.literal('unknown'), source: sourceSchema, status: z.enum(['processed', 'partially_processed', 'failed']),
  page_count: z.number().int().positive(), error_count: z.number().int().nonnegative(),
  worksheets: z.array(z.object({ name: z.string(), page_number: z.number().int().positive() }).strict()), warnings: z.array(z.string()),
  artifacts: z.array(z.object({
    name: z.string().regex(/^part-\d{5}\.jsonl\.gz$/), key: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive(), uncompressed_bytes: z.number().int().positive().max(4_194_304), records: z.number().int().positive().max(50),
  }).strict()).max(100_000),
}).strict();
const reference = z.record(z.string(), z.unknown());
const blockSchema = z.object({
  block_type: z.enum(['text', 'table', 'cell']), text: z.string(), bounding_box: z.array(z.number().finite()).length(4).nullable(),
  confidence: z.number().min(0).max(1).nullable(), source_reference: reference, table_data: z.union([z.array(z.unknown()), reference]).nullable(),
}).strict();
const envelope = { schema_version: z.literal(1), tenant_id: z.uuid(), document_id: z.uuid(), run_id: z.uuid(), page_number: z.number().int().positive() };
export const processingRecordSchema = z.discriminatedUnion('record_type', [
  z.object({ ...envelope, record_type: z.literal('page'), source_kind: z.enum(['pdf_page', 'image_frame', 'worksheet', 'csv']),
    extraction_method: z.enum(['digital_text', 'ocr', 'spreadsheet', 'csv', 'none']), text: z.string(), blocks: z.array(blockSchema),
    width: z.number().positive().nullable(), height: z.number().positive().nullable(), coordinate_system: z.enum(['pdf_points', 'image_pixels', 'worksheet']),
    ocr_confidence: z.number().min(0).max(1).nullable(), worksheet_name: z.string().nullable(), source_reference: reference,
    warnings: z.array(z.string()), error_code: z.string().nullable(),
  }).strict(),
  z.object({ ...envelope, record_type: z.literal('worksheet_rows'), worksheet_name: z.string(), row_start: z.number().int().positive(), row_end: z.number().int().positive(),
    cells: z.array(z.object({ reference: z.string(), row: z.number().int().positive(), column: z.number().int().positive(),
      value: z.union([z.string(), z.boolean()]).nullable(), value_type: z.string(), formula: z.string().nullable(),
      cached_value: z.union([z.string(), z.boolean()]).nullable(), source_reference: reference,
    }).strict()).max(500),
  }).strict(),
  z.object({ ...envelope, record_type: z.literal('source_error'), error_code: z.string() }).strict(),
]);
export type ProcessingManifest = z.infer<typeof processingManifestSchema>;
export type ProcessingRecord = z.infer<typeof processingRecordSchema>;
