import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { invoiceCandidateSchema } from '@doc/contracts';
import { ServiceError } from '@doc/core';

export const ambiguousCandidateReasons = new Set(['AMBIGUOUS_BOUNDARY', 'CONFLICTING_PAGE_IDENTITIES', 'CANDIDATE_LIMIT_EXCEEDED']);
/** Caller supplies an existing tenant transaction. Scheduling and the source checkpoint commit together. */
export async function enqueueInvoiceExtractions(client: pg.PoolClient, input: { tenantId: string; documentId: string; configured: boolean;
  candidateId?: string; requestKey?: string; maxDispatchFailures: number }) {
  if (!input.configured) return [];
  const document = (await client.query<{ run_id: string | null }>("SELECT metadata#>>'{understanding,runId}' AS run_id FROM public.documents WHERE id=$1 FOR UPDATE", [input.documentId])).rows[0];
  if (!document) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
  if (!document.run_id) throw new ServiceError('UNDERSTANDING_NOT_READY', 409, 'Document understanding is not ready.');
  const rows = (await client.query<{ id: string; data: unknown }>(
    'SELECT id,data FROM public.invoice_candidates WHERE understanding_run_id=$1 AND document_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY ordinal',
    [document.run_id, input.documentId, input.candidateId ?? null],
  )).rows;
  const jobs: { id: string; candidate_id: string; status: string }[] = [];
  for (const row of rows) {
    const candidate = invoiceCandidateSchema.parse(row.data);
    if (candidate.document_type !== 'invoice' || candidate.review_reasons.some((code) => ambiguousCandidateReasons.has(code))) continue;
    const key = 'extract:' + row.id + ':invoice-extraction-v1:' + (input.requestKey ?? 'automatic');
    const id = randomUUID();
    await client.query(
      "INSERT INTO public.processing_jobs (id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,max_attempts,payload,dispatch_state,dispatch_max_failures,extraction_candidate_id,source_understanding_run_id) VALUES ($1::uuid,$2,$3,'extract','invoice-extraction-v1',$4,'extraction-queue',$1::text,2,$5,'pending',$6,$7,$8) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING",
      [id, input.tenantId, input.documentId, key, JSON.stringify({ schemaVersion: 1, stage: 'extract', jobId: id, tenantId: input.tenantId,
        documentId: input.documentId, candidateId: row.id, understandingRunId: document.run_id }), input.maxDispatchFailures, row.id, document.run_id],
    );
    const job = (await client.query<{ id: string; status: string }>('SELECT id,status FROM public.processing_jobs WHERE idempotency_key=$1', [key])).rows[0]!;
    jobs.push({ ...job, candidate_id: row.id });
  }
  if (input.candidateId && !jobs.length) throw new ServiceError('CANDIDATE_REQUIRES_REVIEW', 409, 'The requested invoice candidate is absent or its boundaries require review.');
  return jobs;
}
