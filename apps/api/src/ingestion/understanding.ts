import type pg from 'pg';
import { z } from 'zod';
import { understandingResponseSchema } from '@doc/contracts';
import { withTenantTransaction } from '@doc/database';
import type { TenantContext } from '@doc/database';
import { ServiceError } from '@doc/core';

export const understandingQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict();
const cursorSchema = z.object({ runId: z.uuid(), ordinal: z.number().int().positive() }).strict();

export async function readUnderstanding(pool: pg.Pool, tenant: TenantContext, documentId: string, query: z.infer<typeof understandingQuerySchema>) {
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
    catch { throw new ServiceError('INVALID_CURSOR', 400, 'Invalid understanding result cursor.'); }
  }
  return withTenantTransaction(pool, tenant, async (client) => {
    const document = (await client.query<{ run_id: string | null }>("SELECT metadata#>>'{understanding,runId}' AS run_id FROM public.documents WHERE id=$1", [documentId])).rows[0];
    if (!document) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
    if (cursor && cursor.runId !== document.run_id) throw new ServiceError('RESULT_VERSION_CHANGED', 409, 'The active understanding result changed; restart pagination.');
    if (!document.run_id) return understandingResponseSchema.parse({ document_id: documentId, run: null, candidates: [], next_cursor: null });
    const run = (await client.query('SELECT * FROM public.document_understanding_runs WHERE id=$1 AND document_id=$2', [document.run_id, documentId])).rows[0];
    if (!run) throw new ServiceError('UNDERSTANDING_UNAVAILABLE', 503, 'Understanding result is unavailable.');
    const rows = (await client.query<{ ordinal: number; data: unknown }>(
      'SELECT ordinal,data FROM public.invoice_candidates WHERE understanding_run_id=$1 AND document_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT $4',
      [document.run_id, documentId, cursor?.ordinal ?? 0, query.limit + 1],
    )).rows;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return understandingResponseSchema.parse({ document_id: documentId, run: {
      run_id: run.id, document_id: run.document_id, source_version: run.source_version, algorithm_version: run.algorithm_version,
      document_type: run.document_type, segmentation_confidence: Number(run.segmentation_confidence), requires_manual_review: run.requires_manual_review,
      candidate_count: run.candidate_count, invoice_candidate_count: run.invoice_candidate_count, ai_status: run.ai_status,
      warnings: run.warnings, created_at: (run.created_at as Date).toISOString(),
    }, candidates: page.map((row) => row.data), next_cursor: rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ runId: document.run_id, ordinal: last.ordinal })).toString('base64url') : null });
  }, { isolationLevel: 'repeatable read' });
}
