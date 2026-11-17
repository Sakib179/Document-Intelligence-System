import { randomUUID, createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type pg from 'pg';
import { ingestionPayloadSchema } from '@doc/contracts';
import type { IngestionPayload } from '@doc/contracts';
import { withTenantTransaction, enqueueInvoiceExtractions } from '@doc/database';
import type { RuntimeEnvironment } from '@doc/core';
import { DocumentProcessingClient, persistProcessing, ProcessingFailure } from './processing.js';
import { UnderstandingEngine } from './understanding/engine.js';
import { adviseUnderstanding, createBoundaryAdvisor } from './understanding/advisor.js';
import { persistUnderstanding } from './understanding/persistence.js';

class IntegrityError extends Error { constructor(readonly code: string) { super(code); } }
type Execution = { kind: 'done' } | { kind: 'terminal' } | { kind: 'defer'; until: number } | { kind: 'execute'; token: string };

export class IngestionProcessor {
  constructor(private readonly database: pg.Pool, private readonly storage: S3Client, private readonly environment: RuntimeEnvironment) {}

  async process(job: Job, token?: string) {
    let payload: IngestionPayload;
    try {
      payload = ingestionPayloadSchema.parse(job.data);
      if (job.name !== 'ingest' || job.id !== payload.jobId) throw new Error('Invalid queue job');
    } catch { throw new UnrecoverableError('INVALID_JOB_PAYLOAD'); }
    const execution = await this.claim(payload);
    if (execution.kind === 'done') return { stage: 'document_processing_complete' };
    if (execution.kind === 'terminal') throw new UnrecoverableError('JOB_TERMINAL');
    if (execution.kind === 'defer') {
      await job.moveToDelayed(execution.until, token);
      throw new DelayedError();
    }
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void withTenantTransaction(this.database, { tenantId: payload.tenantId, reason: 'Renew document processing execution lease' },
        (client) => client.query("UPDATE public.processing_jobs SET execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1 AND execution_lease_token=$2 AND status='running'", [payload.jobId, execution.token]),
      ).catch(() => undefined).finally(() => { heartbeatBusy = false; });
    }, 30_000);
    heartbeat.unref();
    try {
      try { await this.verifyObject(payload); }
      catch (error) {
        if (error instanceof IntegrityError) throw error;
        throw new ProcessingFailure('STORAGE_UNAVAILABLE');
      }
      const processing = new DocumentProcessingClient(this.environment);
      const manifest = await processing.process(payload, execution.token);
      const engine = new UnderstandingEngine(payload.documentId, manifest.run_id);
      const evidence = await persistProcessing(this.database, processing, payload, manifest, execution.token, (record, origin) => engine.consume(record, origin));
      const understanding = engine.finish(manifest.page_count);
      const aiStatus = await adviseUnderstanding(understanding, {
        enabled: this.environment.SEGMENTATION_AI_ENABLED, maximumCalls: this.environment.SEGMENTATION_AI_MAX_CALLS,
        advisor: createBoundaryAdvisor(this.environment),
        approval: () => withTenantTransaction(this.database, { tenantId: payload.tenantId }, async (client) => {
          const row = (await client.query<{ allowed: boolean; approvedBy: string | null; approvedAt: string | null }>(
            'SELECT cloud_processing_allowed AS allowed,cloud_approved_by AS "approvedBy",cloud_approved_at::text AS "approvedAt" FROM public.documents WHERE id=$1', [payload.documentId],
          )).rows[0];
          return row ?? { allowed: false, approvedBy: null, approvedAt: null };
        }),
        beforeCall: (candidateId, input, approval) => withTenantTransaction(this.database, { tenantId: payload.tenantId, reason: 'Record explicitly approved Gemini segmentation advice request' }, async (client) => {
          const result = await client.query("UPDATE public.processing_jobs SET progress=progress || jsonb_build_object('cloud_advice_request',$3::jsonb) WHERE id=$1 AND execution_lease_token=$2 AND status='running' AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id=$4 AND d.cloud_processing_allowed AND d.cloud_approved_by=$5 AND d.cloud_approved_at=$6::timestamptz) RETURNING id",
            [payload.jobId, execution.token, JSON.stringify({ candidateId, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
              provider: 'gemini', model: this.environment.GEMINI_SEGMENTATION_MODEL, inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), requestedAt: new Date().toISOString() }),
              payload.documentId, approval.approvedBy, approval.approvedAt]);
          if (!result.rowCount) throw new ProcessingFailure('EXECUTION_LEASE_LOST', true);
        }),
      });
      const checkpoint = { stage: 'document_processing_complete', sha256Verified: true, ...evidence, runId: manifest.run_id,
        processorVersion: manifest.processor_version, pageCount: manifest.page_count, errorCount: manifest.error_count, warnings: manifest.warnings };
      const completed = await withTenantTransaction(this.database, { tenantId: payload.tenantId, reason: 'Complete document processing and retain artifact references' }, async (client) => {
        const updated = await client.query(
          "UPDATE public.processing_jobs SET status=$5,finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$6,last_error_message=NULL,checkpoint=$3,progress=$4 WHERE id=$1 AND execution_lease_token=$2 AND status='running' RETURNING id",
          [payload.jobId, execution.token, JSON.stringify(checkpoint), JSON.stringify({ completed: true, pages: manifest.page_count }),
            manifest.status === 'failed' ? 'failed' : 'succeeded', manifest.status === 'failed' ? 'DOCUMENT_PAGES_FAILED' : null],
        );
        if (!updated.rowCount) return false;
        const summary = await persistUnderstanding(client, { payload, runId: manifest.run_id, ...evidence, result: understanding, aiStatus });
        await client.query("UPDATE public.documents SET processing_status=$2,document_type=$4,metadata=jsonb_set(jsonb_set(jsonb_set(metadata,'{ingestion,verifiedAt}',to_jsonb(clock_timestamp())),'{processing}',$3),'{understanding}',$5) WHERE id=$1",
          [payload.documentId, manifest.status, JSON.stringify(checkpoint), understanding.documentType === 'invoice' && summary.invoiceCandidateCount > 1 ? 'invoice_bundle'
            : understanding.documentType === 'other_business' ? 'other' : understanding.documentType, JSON.stringify(summary)]);
        if (manifest.status !== 'failed' && this.environment.EXTRACTION_AUTO_START) await enqueueInvoiceExtractions(client, { tenantId: payload.tenantId, documentId: payload.documentId,
          configured: this.environment.CLOUD_LLM_ENABLED || Boolean(this.environment.LOCAL_LLM_BASE_URL), maxDispatchFailures: this.environment.OUTBOX_MAX_FAILURES });
        return true;
      });
      if (!completed) throw new ProcessingFailure('EXECUTION_LEASE_LOST', true);
      if (manifest.status === 'failed') throw new UnrecoverableError('DOCUMENT_PAGES_FAILED');
      return { stage: 'document_processing_complete', manifestKey: evidence.manifestKey };
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      const permanent = error instanceof IntegrityError || (error instanceof ProcessingFailure && error.permanent);
      const code = error instanceof IntegrityError || error instanceof ProcessingFailure ? error.code : 'PROCESSING_UNAVAILABLE';
      const terminal = await withTenantTransaction(this.database, { tenantId: payload.tenantId, reason: 'Persist ingestion execution failure' }, async (client) => {
        const row = (await client.query<{ attempts: number; max_attempts: number }>('SELECT attempts,max_attempts FROM public.processing_jobs WHERE id=$1 AND execution_lease_token=$2 FOR UPDATE', [payload.jobId, execution.token])).rows[0];
        if (!row) return true;
        const failed = permanent || row.attempts >= row.max_attempts;
        await client.query(
          "UPDATE public.processing_jobs SET status=$3,finished_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END,execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$5,last_error_message='Document verification or processing could not finish' WHERE id=$1 AND execution_lease_token=$2",
          [payload.jobId, execution.token, failed ? 'failed' : 'retry_wait', failed, code],
        );
        await client.query('UPDATE public.documents SET processing_status=$2 WHERE id=$1', [payload.documentId, failed ? 'failed' : 'queued']);
        return failed;
      });
      if (terminal) throw new UnrecoverableError(code);
      throw new Error(code);
    } finally { clearInterval(heartbeat); }
  }

  private async claim(payload: IngestionPayload): Promise<Execution> {
    return withTenantTransaction(this.database, { tenantId: payload.tenantId, reason: 'Claim an ingestion execution lease' }, async (client) => {
      const row = (await client.query<{
        payload: unknown; status: string; attempts: number; max_attempts: number; execution_lease_until: Date | null; processing_status: string;
      }>('SELECT j.*,d.processing_status FROM public.processing_jobs j JOIN public.documents d ON (d.tenant_id,d.id)=(j.tenant_id,j.document_id) WHERE j.id=$1 AND j.document_id=$2 AND j.job_type=$3 FOR UPDATE OF j,d', [payload.jobId, payload.documentId, 'ingest'])).rows[0];
      if (!row || JSON.stringify(ingestionPayloadSchema.parse(row.payload)) !== JSON.stringify(payload)) throw new UnrecoverableError('JOB_REFERENCE_MISMATCH');
      if (row.status === 'succeeded') return { kind: 'done' };
      if (['failed', 'cancelled'].includes(row.status)) return { kind: 'terminal' };
      if (['rejected', 'cancelled'].includes(row.processing_status)) {
        await client.query("UPDATE public.processing_jobs SET status='cancelled',finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL WHERE id=$1", [payload.jobId]);
        return { kind: 'terminal' };
      }
      if (row.status === 'running' && row.execution_lease_until && row.execution_lease_until.getTime() > Date.now()) {
        return { kind: 'defer', until: row.execution_lease_until.getTime() + 100 };
      }
      if (row.attempts >= row.max_attempts) {
        await client.query("UPDATE public.processing_jobs SET status='failed',finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code='PROCESSING_RETRIES_EXHAUSTED' WHERE id=$1", [payload.jobId]);
        await client.query("UPDATE public.documents SET processing_status='failed' WHERE id=$1", [payload.documentId]);
        return { kind: 'terminal' };
      }
      const executionToken = randomUUID();
      await client.query("UPDATE public.processing_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,execution_lease_token=$2,execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1", [payload.jobId, executionToken]);
      await client.query("UPDATE public.documents SET processing_status='processing' WHERE id=$1", [payload.documentId]);
      return { kind: 'execute', token: executionToken };
    });
  }

  private async verifyObject(payload: IngestionPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.environment.S3_OPERATION_TIMEOUT_MS);
    try {
      const object = await this.storage.send(new GetObjectCommand({ Bucket: payload.storage.bucket, Key: payload.storage.key }), { abortSignal: controller.signal });
      const body = object.Body;
      if (!body) throw new IntegrityError('OBJECT_EMPTY');
      try {
        if (object.ContentLength !== payload.storage.sizeBytes || object.ContentType !== payload.storage.mimeType
          || object.Metadata?.['tenant-id'] !== payload.tenantId || object.Metadata?.['document-id'] !== payload.documentId
          || object.Metadata?.sha256 !== payload.storage.sha256) throw new IntegrityError('OBJECT_METADATA_MISMATCH');
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > payload.storage.sizeBytes) throw new IntegrityError('OBJECT_SIZE_MISMATCH');
          hash.update(chunk);
        }
        if (size !== payload.storage.sizeBytes || hash.digest('hex') !== payload.storage.sha256) throw new IntegrityError('OBJECT_CHECKSUM_MISMATCH');
      } finally {
        if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NoSuchKey') throw new IntegrityError('OBJECT_NOT_FOUND');
      throw error;
    } finally { clearTimeout(timer); }
  }
}
