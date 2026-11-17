import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { documentDtoSchema, uploadAcceptedSchema } from '@doc/contracts';
import type { DocumentDto, UploadAccepted } from '@doc/contracts';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction } from '@doc/database';
import type { TenantContext } from '@doc/database';
import type { ValidatedFile } from './files.js';

export type DocumentRow = {
  id: string; tenant_id: string; upload_batch_id: string | null; original_filename: string; mime_type: string;
  file_size_bytes: string; sha256: string; object_storage_key: string; document_type: string; page_count: number | null;
  processing_status: string; created_at: Date; precise_created_at?: string;
  metadata: { ingestion?: { storageBucket?: string; fileIndex?: number; duplicateOfDocumentId?: string; antivirus?: unknown; inspection?: unknown; errorCode?: string } };
};
type BatchRow = { id: string; status: string; uploaded_by: string | null; request_fingerprint: string; ingestion_lease_token: string | null; ingestion_lease_until: Date | null };

export function documentDto(row: DocumentRow): DocumentDto {
  return documentDtoSchema.parse({
    id: row.id, uploadBatchId: row.upload_batch_id, originalFilename: row.original_filename, mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes), sha256: row.sha256, documentType: row.document_type,
    pageCount: row.page_count, processingStatus: row.processing_status,
    duplicateOfDocumentId: row.metadata.ingestion?.duplicateOfDocumentId ?? null,
    antivirus: row.metadata.ingestion?.antivirus ?? null, createdAt: row.created_at.toISOString(),
  });
}

export class IngestionRepository {
  constructor(private readonly pool: pg.Pool, private readonly environment: RuntimeEnvironment) {}

  async findReplay(context: TenantContext, key: string, fingerprint: string): Promise<UploadAccepted | null> {
    return withTenantTransaction(this.pool, context, async (client) => {
      const batch = (await client.query<BatchRow>('SELECT * FROM public.upload_batches WHERE tenant_id=$1 AND idempotency_key=$2', [context.tenantId, key])).rows[0];
      if (!batch) return null;
      this.checkRequest(batch, context, fingerprint);
      if (batch.status !== 'uploaded') return null;
      return this.accepted(client, batch.id, context.tenantId, key, true);
    });
  }

  private checkRequest(batch: BatchRow, context: TenantContext, fingerprint: string) {
    if (batch.uploaded_by !== context.actorUserId || batch.request_fingerprint !== fingerprint) {
      throw new ServiceError('IDEMPOTENCY_CONFLICT', 409, 'This idempotency key belongs to a different upload.');
    }
  }

  async reserve(context: TenantContext, key: string, fingerprint: string, files: ValidatedFile[]) {
    const lease = randomUUID();
    return withTenantTransaction(this.pool, context, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [context.tenantId + ':' + key]);
      let batch = (await client.query<BatchRow>('SELECT * FROM public.upload_batches WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE', [context.tenantId, key])).rows[0];
      if (batch) {
        this.checkRequest(batch, context, fingerprint);
        if (batch.status === 'uploaded') return { replay: await this.accepted(client, batch.id, context.tenantId, key, true), batchId: batch.id, lease, documents: [] as DocumentRow[] };
        if (batch.status === 'uploading' && batch.ingestion_lease_until && batch.ingestion_lease_until.getTime() > Date.now()) {
          throw new ServiceError('UPLOAD_IN_PROGRESS', 409, 'This upload is already in progress. Retry with the same key.');
        }
        await client.query("UPDATE public.upload_batches SET status='uploading',ingestion_lease_token=$2,ingestion_lease_until=clock_timestamp()+make_interval(secs=>$3) WHERE id=$1", [batch.id, lease, this.environment.UPLOAD_LEASE_SECONDS]);
        await client.query("UPDATE public.documents SET processing_status='uploading' WHERE upload_batch_id=$1", [batch.id]);
      } else {
        batch = (await client.query<BatchRow>(
          "INSERT INTO public.upload_batches (tenant_id,uploaded_by,status,expected_file_count,idempotency_key,request_fingerprint,ingestion_lease_token,ingestion_lease_until) VALUES ($1,$2,'uploading',$3,$4,$5,$6,clock_timestamp()+make_interval(secs=>$7)) RETURNING *",
          [context.tenantId, context.actorUserId, files.length, key, fingerprint, lease, this.environment.UPLOAD_LEASE_SECONDS],
        )).rows[0];
        if (!batch) throw new Error('Upload reservation failed');
        for (const [fileIndex, file] of files.entries()) {
          const id = randomUUID();
          const duplicate = (await client.query<{ id: string }>("SELECT id FROM public.documents WHERE tenant_id=$1 AND sha256=$2 AND processing_status NOT IN ('failed','rejected','cancelled') ORDER BY created_at,id LIMIT 1", [context.tenantId, file.sha256])).rows[0];
          const metadata = { workflow: {enabled:this.environment.WORKFLOW_ENABLED}, ingestion: {
            storageBucket: this.environment.S3_BUCKET, fileIndex, inspection: file.inspection, antivirus: file.antivirus,
            ...(duplicate ? { duplicateOfDocumentId: duplicate.id } : {}),
          } };
          await client.query(
            "INSERT INTO public.documents (id,tenant_id,upload_batch_id,uploaded_by,original_filename,mime_type,file_size_bytes,sha256,object_storage_key,document_type,page_count,processing_status,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'uploading',$12)",
            [id, context.tenantId, batch.id, context.actorUserId, file.filename, file.mimeType, file.sizeBytes, file.sha256,
              'tenants/' + context.tenantId + '/documents/' + id + '/source' + file.extension,
              ['spreadsheet', 'csv'].includes(file.inspection.kind) ? 'spreadsheet' : 'unknown', file.inspection.pageCount, JSON.stringify(metadata)],
          );
        }
      }
      const documents = (await client.query<DocumentRow>("SELECT * FROM public.documents WHERE upload_batch_id=$1 ORDER BY (metadata#>>'{ingestion,fileIndex}')::int", [batch.id])).rows;
      if (documents.length !== files.length || documents.some((document, index) => document.sha256 !== files[index]?.sha256 || Number(document.file_size_bytes) !== files[index]?.sizeBytes)) {
        throw new ServiceError('UPLOAD_STATE_CONFLICT', 409, 'The stored upload reservation does not match this request.');
      }
      return { replay: null, batchId: batch.id, lease, documents };
    });
  }

  async finalize(context: TenantContext, reservation: { batchId: string; lease: string }, key: string): Promise<UploadAccepted> {
    return withTenantTransaction(this.pool, context, async (client) => {
      const batch = (await client.query<BatchRow>('SELECT * FROM public.upload_batches WHERE id=$1 FOR UPDATE', [reservation.batchId])).rows[0];
      if (!batch || batch.ingestion_lease_token !== reservation.lease) throw new ServiceError('UPLOAD_LEASE_LOST', 409, 'Retry the upload using the same idempotency key.');
      const documents = (await client.query<DocumentRow>('SELECT * FROM public.documents WHERE upload_batch_id=$1 ORDER BY id', [batch.id])).rows;
      for (const document of documents) {
        const jobId = randomUUID();
        const payload = {
          schemaVersion: 1, jobId, tenantId: context.tenantId, documentId: document.id,
          storage: { bucket: this.environment.S3_BUCKET, key: document.object_storage_key, sha256: document.sha256, sizeBytes: Number(document.file_size_bytes), mimeType: document.mime_type },
        };
        await client.query("UPDATE public.documents SET processing_status='uploaded' WHERE id=$1", [document.id]);
        await client.query(
          "INSERT INTO public.processing_jobs (id,tenant_id,document_id,job_type,pipeline_version,idempotency_key,queue_name,queue_job_id,max_attempts,payload,dispatch_state,dispatch_max_failures) VALUES ($1::uuid,$2,$3,'ingest','document-v1',$4,'document-queue',$1::text,$5,$6,'pending',$7)",
          [jobId, context.tenantId, document.id, 'ingest:' + document.id + ':v1', this.environment.INGESTION_JOB_ATTEMPTS, JSON.stringify(payload), this.environment.OUTBOX_MAX_FAILURES],
        );
      }
      await client.query("UPDATE public.upload_batches SET status='uploaded',ingestion_lease_token=NULL,ingestion_lease_until=NULL WHERE id=$1", [batch.id]);
      return this.accepted(client, batch.id, context.tenantId, key, false);
    });
  }

  async markStorageFailure(context: TenantContext, reservation: { batchId: string; lease: string }): Promise<void> {
    await withTenantTransaction(this.pool, context, async (client) => {
      const result = await client.query("UPDATE public.upload_batches SET status='failed',ingestion_lease_token=NULL,ingestion_lease_until=NULL WHERE id=$1 AND ingestion_lease_token=$2 AND status='uploading' RETURNING id", [reservation.batchId, reservation.lease]);
      if (result.rowCount) {
        await client.query("UPDATE public.documents SET processing_status='failed',metadata=jsonb_set(metadata,'{ingestion,errorCode}','\"STORAGE_WRITE_FAILED\"') WHERE upload_batch_id=$1", [reservation.batchId]);
      }
    });
  }

  private async accepted(client: pg.PoolClient, batchId: string, tenantId: string, key: string, replayed: boolean): Promise<UploadAccepted> {
    const documents = (await client.query<DocumentRow>("SELECT * FROM public.documents WHERE tenant_id=$1 AND upload_batch_id=$2 ORDER BY (metadata#>>'{ingestion,fileIndex}')::int", [tenantId, batchId])).rows;
    return uploadAcceptedSchema.parse({ batchId, status: 'accepted', idempotencyKey: key, replayed, documents: documents.map(documentDto) });
  }

  async getDocument(context: TenantContext, id: string): Promise<DocumentRow> {
    return withTenantTransaction(this.pool, context, async (client) => {
      const document = (await client.query<DocumentRow>("SELECT * FROM public.documents WHERE id=$1 AND NOT (metadata ? 'deleted')", [id])).rows[0];
      if (!document) throw new ServiceError('DOCUMENT_NOT_FOUND', 404, 'Document not found.');
      return document;
    });
  }

  async list(context: TenantContext, query: { limit: number; status?: string | undefined; batchId?: string | undefined; cursor?: { createdAt: string; id: string } | undefined }) {
    return withTenantTransaction(this.pool, context, async (client) => {
      const values: unknown[] = [context.tenantId];
      const filters = ['d.tenant_id=$1', "NOT (d.metadata ? 'deleted')"];
      if (query.status) { values.push(query.status); filters.push('d.processing_status=$' + values.length); }
      if (query.batchId) { values.push(query.batchId); filters.push('d.upload_batch_id=$' + values.length); }
      if (query.cursor) {
        values.push(query.cursor.createdAt, query.cursor.id);
        filters.push('(d.created_at,d.id)<($' + (values.length - 1) + '::timestamptz,$' + values.length + '::uuid)');
      }
      values.push(query.limit + 1);
      return (await client.query<DocumentRow>(
        "SELECT d.*,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS precise_created_at FROM public.documents d WHERE " + filters.join(' AND ') + ' ORDER BY d.created_at DESC,d.id DESC LIMIT $' + values.length, values,
      )).rows;
    });
  }

  async jobStatuses(context: TenantContext, documentId: string) {
    await this.getDocument(context, documentId);
    return withTenantTransaction(this.pool, context, async (client) => (await client.query(
      'SELECT id,queue_name,status,dispatch_state,attempts,max_attempts,dispatch_failures,last_error_code,created_at,finished_at FROM public.processing_jobs WHERE document_id=$1 ORDER BY created_at,id', [documentId],
    )).rows.map((row) => ({
      id: row.id, queue: row.queue_name, status: row.status, dispatchState: row.dispatch_state,
      attempts: row.attempts, maxAttempts: row.max_attempts, dispatchFailures: row.dispatch_failures,
      errorCode: row.last_error_code, createdAt: (row.created_at as Date).toISOString(), finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    })));
  }

  async batch(context: TenantContext, batchId: string) {
    return withTenantTransaction(this.pool, context, async (client) => {
      const batch = (await client.query<{ id: string; status: string }>('SELECT id,status FROM public.upload_batches WHERE id=$1', [batchId])).rows[0];
      if (!batch) throw new ServiceError('BATCH_NOT_FOUND', 404, 'Upload batch not found.');
      const documents = (await client.query<DocumentRow>('SELECT * FROM public.documents WHERE upload_batch_id=$1 ORDER BY created_at,id', [batchId])).rows;
      return { batchId: batch.id, status: batch.status, documents: documents.map(documentDto) };
    });
  }
}
