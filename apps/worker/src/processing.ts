import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { processingManifestSchema, processingRecordSchema } from '@doc/contracts';
import type { IngestionPayload, ProcessingManifest, ProcessingRecord } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction } from '@doc/database';

export class ProcessingFailure extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new ProcessingFailure('PROCESSOR_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maximum) throw new ProcessingFailure('PROCESSOR_RESPONSE_LIMIT', true);
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export class DocumentProcessingClient {
  constructor(private readonly environment: RuntimeEnvironment) {}

  private async request(path: string, init: RequestInit = {}) {
    return fetch('http://' + this.environment.PROCESSOR_HOST + ':' + this.environment.PROCESSOR_PORT + path, {
      ...init, headers: { authorization: 'Bearer ' + this.environment.PROCESSOR_INTERNAL_TOKEN, ...init.headers },
      signal: AbortSignal.timeout((this.environment.PROCESSING_TIMEOUT_SECONDS + 120) * 1000),
    });
  }

  async process(payload: IngestionPayload, runId: string): Promise<ProcessingManifest> {
    const extension = payload.storage.key.slice(payload.storage.key.lastIndexOf('.'));
    const response = await this.request('/internal/process', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, tenant_id: payload.tenantId, document_id: payload.documentId, run_id: runId,
        source: { bucket: payload.storage.bucket, key: payload.storage.key, sha256: payload.storage.sha256, size_bytes: payload.storage.sizeBytes, extension } }),
    });
    const body = await readBounded(response, 4_194_304);
    if (!response.ok) {
      let code = 'PROCESSOR_UNAVAILABLE';
      try {
        const candidate = JSON.parse(body.toString())?.error?.code;
        if (typeof candidate === 'string' && /^[A-Z_]{3,80}$/.test(candidate)) code = candidate;
      } catch { /* Return a safe error, without reflecting server text. */ }
      throw new ProcessingFailure(code, response.status >= 400 && response.status < 500 && response.status !== 429);
    }
    const parsed = processingManifestSchema.safeParse(JSON.parse(body.toString()));
    if (!parsed.success) throw new ProcessingFailure('INVALID_PROCESSING_MANIFEST', true);
    const manifest = parsed.data;
    if (manifest.tenant_id !== payload.tenantId || manifest.document_id !== payload.documentId || manifest.run_id !== runId
      || manifest.source.bucket !== payload.storage.bucket || manifest.source.key !== payload.storage.key
      || manifest.source.sha256 !== payload.storage.sha256 || manifest.source.size_bytes !== payload.storage.sizeBytes
      || manifest.source.extension !== extension || manifest.artifacts.length === 0
      || manifest.page_count > this.environment.UPLOAD_MAX_PAGES) throw new ProcessingFailure('PROCESSOR_REFERENCE_MISMATCH', true);
    const prefix = `tenants/${payload.tenantId}/documents/${payload.documentId}/processing/${runId}/`;
    if (new Set(manifest.artifacts.map((artifact) => artifact.name)).size !== manifest.artifacts.length
      || manifest.artifacts.some((artifact, index) => artifact.name !== 'part-' + String(index).padStart(5, '0') + '.jsonl.gz' || artifact.key !== prefix + artifact.name)) {
      throw new ProcessingFailure('PROCESSOR_REFERENCE_MISMATCH', true);
    }
    return manifest;
  }

  async *records(manifest: ProcessingManifest): AsyncGenerator<{ record: ProcessingRecord; artifact: string; line: number }> {
    let total = 0;
    for (const artifact of manifest.artifacts) {
      total += artifact.uncompressed_bytes;
      if (total > 536_870_912) throw new ProcessingFailure('PROCESSOR_RESPONSE_LIMIT', true);
      const path = `/internal/artifacts/${manifest.tenant_id}/${manifest.document_id}/${manifest.run_id}/${artifact.name}`;
      const response = await this.request(path);
      if (!response.ok) { await response.body?.cancel(); throw new ProcessingFailure('ARTIFACT_UNAVAILABLE'); }
      const compressed = await readBounded(response, 4_194_304);
      if (compressed.length !== artifact.size_bytes || createHash('sha256').update(compressed).digest('hex') !== artifact.sha256) {
        throw new ProcessingFailure('ARTIFACT_CHECKSUM_MISMATCH', true);
      }
      let content: Buffer;
      try { content = gunzipSync(compressed, { maxOutputLength: artifact.uncompressed_bytes + 1 }); }
      catch { throw new ProcessingFailure('INVALID_ARTIFACT_COMPRESSION', true); }
      if (content.length !== artifact.uncompressed_bytes) throw new ProcessingFailure('ARTIFACT_SIZE_MISMATCH', true);
      const lines = content.toString('utf8').split('\n');
      if (lines.pop() !== '' || lines.length !== artifact.records) throw new ProcessingFailure('ARTIFACT_RECORD_MISMATCH', true);
      for (const [index, line] of lines.entries()) {
        let record: ProcessingRecord;
        try { record = processingRecordSchema.parse(JSON.parse(line)); }
        catch { throw new ProcessingFailure('INVALID_ARTIFACT_RECORD', true); }
        if (record.tenant_id !== manifest.tenant_id || record.document_id !== manifest.document_id || record.run_id !== manifest.run_id
          || record.page_number > manifest.page_count) throw new ProcessingFailure('ARTIFACT_REFERENCE_MISMATCH', true);
        yield { record, artifact: artifact.key, line: index + 1 };
      }
    }
  }
}

type StoredPage = { id: string; blocks: number; method: string | null; coordinateSystem: string; worksheet: string | null };

/** Append source snapshots; every bounded write checks the current execution fence. */
export async function persistProcessing(
  database: pg.Pool, client: DocumentProcessingClient, payload: IngestionPayload, manifest: ProcessingManifest, executionToken: string,
  onRecord?: (record: ProcessingRecord, origin: { artifact: string; line: number }) => void,
) {
  const context = { tenantId: payload.tenantId, reason: 'Persist document processing source evidence' };
  const pages = new Map<number, StoredPage>();
  const sourceVersion = await withTenantTransaction(database, context, async (connection) => {
    const result = await connection.query<{ version: number }>('SELECT COALESCE(MAX(source_version),0)+1 AS version FROM public.document_pages WHERE document_id=$1', [payload.documentId]);
    return result.rows[0]!.version;
  });
  for await (const { record, artifact, line } of client.records(manifest)) {
    await withTenantTransaction(database, context, async (connection) => {
      const lock = await connection.query("SELECT id FROM public.processing_jobs WHERE id=$1 AND execution_lease_token=$2 AND status='running' FOR UPDATE", [payload.jobId, executionToken]);
      if (!lock.rowCount) throw new ProcessingFailure('EXECUTION_LEASE_LOST', true);
      let page = pages.get(record.page_number);
      const source = { artifact, line, run_id: manifest.run_id, source_key: payload.storage.key, source_sha256: payload.storage.sha256 };
      if (record.record_type === 'page') {
        if (page) throw new ProcessingFailure('DUPLICATE_ARTIFACT_PAGE', true);
        const method = record.extraction_method === 'digital_text' ? 'digital' : record.extraction_method === 'none' ? null : record.extraction_method;
        page = { id: randomUUID(), blocks: 0, method, coordinateSystem: record.coordinate_system, worksheet: record.worksheet_name };
        await connection.query(
          'INSERT INTO public.document_pages (id,tenant_id,document_id,page_number,source_version,source_kind,extracted_text,extraction_method,ocr_confidence,width,height,coordinate_system,worksheet_name,source_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [page.id, payload.tenantId, payload.documentId, record.page_number, sourceVersion, record.source_kind, record.text, method, record.ocr_confidence,
            record.width, record.height, record.coordinate_system, record.worksheet_name, JSON.stringify({ ...record.source_reference, ...source, warnings: record.warnings, error_code: record.error_code })],
        );
        pages.set(record.page_number, page);
      }
      if (!page) throw new ProcessingFailure('ARTIFACT_PAGE_MISSING', true);
      const blocks = record.record_type === 'page' ? record.blocks.map((block) => ({
        block_type: block.block_type, text: block.text, confidence: block.confidence, bounding_box: block.bounding_box,
        table_data: block.table_data, cell_range: null, source_reference: { ...block.source_reference, ...source },
      })) : record.record_type === 'worksheet_rows' ? record.cells.map((cell) => ({
        block_type: 'cell', text: cell.formula ?? (cell.value === null ? null : String(cell.value)), confidence: null, bounding_box: null,
        table_data: null, cell_range: cell.reference, source_reference: { ...cell.source_reference, ...source, cell },
      })) : [{ block_type: 'text', text: '', confidence: null, bounding_box: null, table_data: null, cell_range: null, source_reference: { ...source, error_code: record.error_code } }];
      // One row batch or PDF page at a time; never accumulate the full document.
      for (let start = 0; start < blocks.length; start += 500) {
        const batch = blocks.slice(start, start + 500).map((block) => ({ ...block, block_number: ++page!.blocks }));
        await connection.query(
          'INSERT INTO public.document_blocks (tenant_id,document_id,page_id,block_number,block_type,extracted_text,extraction_method,ocr_confidence,bounding_box,coordinate_system,table_data,worksheet_name,cell_range,source_reference) SELECT $1,$2,$3,b.block_number,b.block_type,b.text,$4,b.confidence,b.bounding_box,$5,b.table_data,$6,b.cell_range,b.source_reference FROM jsonb_to_recordset($7::jsonb) AS b(block_number integer,block_type text,text text,confidence numeric,bounding_box double precision[],table_data jsonb,cell_range text,source_reference jsonb)',
          [payload.tenantId, payload.documentId, page.id, page.method, page.coordinateSystem, page.worksheet, JSON.stringify(batch)],
        );
      }
    });
    onRecord?.(record, { artifact, line });
  }
  if (pages.size !== manifest.page_count) throw new ProcessingFailure('ARTIFACT_PAGE_COUNT_MISMATCH', true);
  return { sourceVersion, manifestKey: `tenants/${payload.tenantId}/documents/${payload.documentId}/processing/${manifest.run_id}/manifest.json` };
}
