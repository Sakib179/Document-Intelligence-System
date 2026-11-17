import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { searchQuerySchema, HARRIER_EMBEDDING_ID } from '@doc/contracts';
import { embeddingSpace, validEmbedding } from '@doc/core';
import { reciprocalRankFusion } from '@doc/database';
import { extractionEnvironment } from '../fixtures/extraction.js';
import { retrievalMetrics } from '../../scripts/benchmark-embeddings.js';
it('isolates model, revision and instruction vector spaces', () => {
  const env = extractionEnvironment(), original = embeddingSpace(env);
  expect(original.space_id).not.toBe(embeddingSpace({ ...env, EMBEDDING_MODEL_ID: HARRIER_EMBEDDING_ID }).space_id);
  expect(original.space_id).not.toBe(embeddingSpace({ ...env, EMBEDDING_QUERY_INSTRUCTION: 'Different task' }).space_id);
});
it('rejects nonunit, zero, nonfinite and wrong-dimension vectors', () => {
  const vector = Array(1024).fill(0);
  vector[0] = 1;
  expect(validEmbedding(vector)).toBe(true);
  expect(validEmbedding(Array(1024).fill(0))).toBe(false);
  expect(validEmbedding([1])).toBe(false);
  vector[1] = NaN;
  expect(validEmbedding(vector)).toBe(false);
});
it('validates exact search, query bounds and chronological date filters', () => {
  expect(() => searchQuerySchema.parse({ mode: 'exact' })).toThrow();
  expect(() => searchQuerySchema.parse({ mode: 'hybrid', q: 'test', date_from: '2026-10-10', date_to: '2026-01-01' })).toThrow();
  expect(searchQuerySchema.parse({ mode: 'exact', invoice_number: 'INV-101' }).limit).toBe(10);
});
it('fuses ranks rather than mixing incompatible raw lexical and cosine scores', () => {
  const item = (id: string, score: number) => ({ id, document_id: randomUUID(), invoice_id: null, kind: 'chunk' as const, text: 'invoice', source_reference: {}, score, keyword_rank: null, semantic_rank: null });
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const fused = reciprocalRankFusion([item(a, 1000), item(b, 10)], [item(b, 0.9), item(c, 0.8)], 10);
  expect(fused[0]?.id).toBe(b);
  expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61);
  expect(fused[0]?.keyword_rank).toBe(2);
});
it('computes recall, reciprocal rank and graded nDCG from labeled rankings', () => {
  const metrics = retrievalMetrics(['irrelevant', 'a', 'b'], { a: 2, b: 1 });
  expect(metrics.recall_at_5).toBe(1);
  expect(metrics.mrr_at_10).toBe(0.5);
  expect(metrics.ndcg_at_10).toBeGreaterThan(0);
  expect(metrics.ndcg_at_10).toBeLessThan(1);
});
it('refuses to publish recall for a query without positive relevance judgments', () => {
  expect(() => retrievalMetrics(['a'], {})).toThrow('positive relevance');
});
