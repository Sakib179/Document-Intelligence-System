import { z } from 'zod';
export const QWEN_EMBEDDING_ID = 'Qwen/Qwen3-Embedding-0.6B';
export const QWEN_EMBEDDING_VERSION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3';
export const HARRIER_EMBEDDING_ID = 'microsoft/harrier-oss-v1-0.6b';
export const HARRIER_EMBEDDING_VERSION = 'f9b9dc8d367d443f2479d27aa5d8d2850c0774ee';
export const embeddingSpaceSchema = z.object({
  model_id: z.enum([QWEN_EMBEDDING_ID, HARRIER_EMBEDDING_ID]), model_version: z.string().regex(/^[a-f0-9]{40}$/), dimensions: z.literal(1024),
  adapter: z.enum(['qwen3-last-token-v1', 'harrier-last-token-v1']), query_instruction: z.string().min(1).max(500), maximum_tokens: z.number().int(),
  chunker_version: z.literal('structure-qwen-tokenizer-v1'), source_builder_version: z.literal('normalized-invoice-records-v1'), target_tokens: z.number().int(), maximum_chunk_tokens: z.number().int(), space_id: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const chunkUnitSchema = z.object({ unit_id: z.string().min(1).max(120), invoice_id: z.uuid().nullable(), page_number: z.number().int().positive(), worksheet: z.string().max(255).nullable(), cell_range: z.string().max(128).nullable(), section: z.string().max(300), kind: z.enum(['text', 'header', 'table_row']), text: z.string().min(1).max(20000) }).strict();
export const preparedChunkSchema = z.object({ chunk_text: z.string().min(1).max(8000), token_count: z.number().int().positive(), invoice_id: z.uuid().nullable(), page_number: z.number().int().positive(), worksheet: z.string().nullable(), section: z.string(), source_references: z.array(z.record(z.string(), z.unknown())) }).strict();
export const chunkResponseSchema = z.object({ chunker_version: z.literal('structure-qwen-tokenizer-v1'), tokenizer_model: z.literal(QWEN_EMBEDDING_ID), tokenizer_version: z.literal(QWEN_EMBEDDING_VERSION), chunks: z.array(preparedChunkSchema).max(1000) }).strict();
export const embeddingResponseSchema = z.object({ model_id: z.string(), model_version: z.string(), dimensions: z.literal(1024), adapter: z.string(), normalized: z.literal(true), vectors: z.array(z.array(z.number().finite()).length(1024)).max(16), cache_hits: z.number().int().nonnegative(), processing_time_ms: z.number().nonnegative() }).strict();
export const indexingPayloadSchema = z.object({ schemaVersion: z.literal(1), stage: z.literal('index'), jobId: z.uuid(), tenantId: z.uuid(), documentId: z.uuid(), runId: z.uuid() }).strict();
const indexStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']);
export const indexingAcceptedSchema = z.object({ document_id: z.uuid(), run_id: z.uuid(), job_id: z.uuid(), status: indexStatus, space_id: z.string() }).strict();
export const indexingStatusSchema = z.object({
  document_id: z.uuid(), active_space: embeddingSpaceSchema, current_generation: z.string().regex(/^\d+$/), is_current: z.boolean(),
  head: z.object({ runId: z.uuid(), spaceId: z.string(), generation: z.string() }).strict().nullable(),
  runs: z.array(z.object({ id: z.uuid(), status: indexStatus, space_id: z.string(), source_generation: z.string(), source_version: z.number().int(), chunk_count: z.number().int(), cache_hits: z.number().int(), error_code: z.string().nullable(), created_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable() }).strict()).max(20)
}).strict();
export const searchQuerySchema = z.object({ mode: z.enum(['exact', 'filter', 'keyword', 'semantic', 'hybrid']).default('hybrid'), q: z.string().trim().max(500).default(''), invoice_number: z.string().trim().min(1).max(200).optional(), supplier: z.string().trim().min(1).max(200).optional(), date_from: z.iso.date().optional(), date_to: z.iso.date().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), amount_min: z.string().regex(/^-?\d{1,16}(?:\.\d{1,8})?$/).optional(), amount_max: z.string().regex(/^-?\d{1,16}(?:\.\d{1,8})?$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(10) })
  .strict().superRefine((input, ctx) => {
    if (input.mode === 'exact' ? !input.invoice_number : input.mode === 'filter' ? ![input.invoice_number, input.supplier, input.date_from, input.date_to, input.currency, input.amount_min, input.amount_max].some(Boolean) : !input.q)
      ctx.addIssue({ code: 'custom', path: ['q'], message: 'Provide a query or an exact invoice number' });
    if (input.date_from && input.date_to && input.date_from > input.date_to)
      ctx.addIssue({ code: 'custom', path: ['date_to'], message: 'Invalid date range' });
  });
export const searchResultSchema = z.object({ mode: z.string(), space_id: z.string().nullable(), items: z.array(z.object({ kind: z.enum(['chunk', 'invoice']), id: z.uuid(), document_id: z.uuid(), invoice_id: z.uuid().nullable(), text: z.string(), source_reference: z.record(z.string(), z.unknown()), score: z.number().finite(), keyword_rank: z.number().int().nullable(), semantic_rank: z.number().int().nullable() }).strict()) }).strict();
export type EmbeddingSpace = z.infer<typeof embeddingSpaceSchema>;
export type ChunkUnit = z.infer<typeof chunkUnitSchema>;
export type PreparedChunk = z.infer<typeof preparedChunkSchema>;
export type IndexingPayload = z.infer<typeof indexingPayloadSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
