import type pg from 'pg';
import type { IngestionPayload } from '@doc/contracts';
import type { UnderstandingResult } from './engine.js';

export async function persistUnderstanding(connection: pg.PoolClient, input: {
  payload: IngestionPayload; runId: string; sourceVersion: number; manifestKey: string; result: UnderstandingResult; aiStatus: string;
}) {
  const { payload, runId, sourceVersion, manifestKey, result, aiStatus } = input;
  const invoiceCount = result.candidates.filter((candidate) => candidate.document_type === 'invoice').length;
  await connection.query(
    'INSERT INTO public.document_understanding_runs (id,tenant_id,document_id,processing_job_id,source_version,manifest_key,algorithm_version,document_type,segmentation_confidence,requires_manual_review,candidate_count,invoice_candidate_count,ai_status,warnings) VALUES ($1,$2,$3,$4,$5,$6,\'segmentation-v1\',$7,$8,$9,$10,$11,$12,$13)',
    [runId, payload.tenantId, payload.documentId, payload.jobId, sourceVersion, manifestKey, result.documentType, result.confidence, result.requiresReview,
      result.candidates.length, invoiceCount, aiStatus, JSON.stringify(result.warnings)],
  );
  for (let start = 0; start < result.candidates.length; start += 100) {
    const batch = result.candidates.slice(start, start + 100).map((data, index) => ({ id: data.candidate_id, ordinal: start + index + 1,
      document_type: data.document_type, segmentation_confidence: data.segmentation_confidence, requires_manual_review: data.requires_manual_review, data }));
    await connection.query(
      'INSERT INTO public.invoice_candidates (id,tenant_id,document_id,understanding_run_id,ordinal,document_type,segmentation_confidence,requires_manual_review,data) SELECT b.id,$1,$2,$3,b.ordinal,b.document_type,b.segmentation_confidence,b.requires_manual_review,b.data FROM jsonb_to_recordset($4::jsonb) AS b(id uuid,ordinal integer,document_type text,segmentation_confidence numeric,requires_manual_review boolean,data jsonb)',
      [payload.tenantId, payload.documentId, runId, JSON.stringify(batch)],
    );
  }
  return { runId, algorithmVersion: 'segmentation-v1', candidateCount: result.candidates.length, invoiceCandidateCount: invoiceCount,
    requiresManualReview: result.requiresReview, documentType: result.documentType, aiStatus };
}
