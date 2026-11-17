import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { parseEnvironment } from '@doc/core';
import type { IngestionPayload, ProcessingManifest } from '@doc/contracts';
import { DocumentProcessingClient } from '../../apps/worker/src/processing.js';

const environment = parseEnvironment({
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'test_database', POSTGRES_USER: 'test',
  POSTGRES_PASSWORD: 'test-only-password-not-a-secret', POSTGRES_APP_PASSWORD: 'test-only-password-not-a-secret',
  POSTGRES_DISPATCHER_PASSWORD: 'test-only-password-not-a-secret', 
  PROCESSOR_INTERNAL_TOKEN: 'test-only-password-not-a-secret', REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'test-only-password-not-a-secret',
  S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'test-documents',
  S3_ACCESS_KEY: 'test-only-access-key', S3_SECRET_KEY: 'test-only-password-not-a-secret',
});
const tenantId = randomUUID(), documentId = randomUUID(), runId = randomUUID();
const payload: IngestionPayload = { schemaVersion: 1, tenantId, documentId, jobId: randomUUID(),
  storage: { bucket: 'test-documents', key: `tenants/${tenantId}/documents/${documentId}/source.pdf`, sha256: 'a'.repeat(64), sizeBytes: 100, mimeType: 'application/pdf' } };
const client = new DocumentProcessingClient(environment);
function fixture() {
  const record = { schema_version: 1, tenant_id: tenantId, document_id: documentId, run_id: runId, record_type: 'page', page_number: 1,
    source_kind: 'pdf_page', extraction_method: 'digital_text', text: 'Source evidence', blocks: [], width: 100, height: 100,
    coordinate_system: 'pdf_points', ocr_confidence: null, worksheet_name: null, source_reference: { pdf_page: 1 }, warnings: [], error_code: null };
  const content = Buffer.from(JSON.stringify(record) + '\n');
  const compressed = gzipSync(content);
  const manifest: ProcessingManifest = { schema_version: 1, processor_version: 'document-v1', tenant_id: tenantId, document_id: documentId,
    run_id: runId, document_type: 'unknown', source: { bucket: payload.storage.bucket, key: payload.storage.key, sha256: payload.storage.sha256, size_bytes: 100, extension: '.pdf' },
    status: 'processed', page_count: 1, error_count: 0, worksheets: [], warnings: [],
    artifacts: [{ name: 'part-00000.jsonl.gz', key: `tenants/${tenantId}/documents/${documentId}/processing/${runId}/part-00000.jsonl.gz`,
      sha256: createHash('sha256').update(compressed).digest('hex'), size_bytes: compressed.length, uncompressed_bytes: content.length, records: 1 }],
  };
  return { record, content, compressed, manifest };
}
async function collect(manifest: ProcessingManifest) { const records = []; for await (const record of client.records(manifest)) records.push(record); return records; }
afterEach(() => vi.unstubAllGlobals());

it('uses internal authentication and reads validated compressed records with source references', async () => {
  const { compressed, manifest } = fixture();
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ' + environment.PROCESSOR_INTERNAL_TOKEN);
    return init.method === 'POST' ? Response.json(manifest) : new Response(compressed);
  });
  vi.stubGlobal('fetch', request);
  const result = await client.process(payload, runId);
  const records = await collect(result);
  expect(records[0]?.record.record_type).toBe('page');
  expect(records[0]?.line).toBe(1);
});

it('rejects cross-tenant manifests and artifact key substitution', async () => {
  const { manifest } = fixture();
  vi.stubGlobal('fetch', async () => Response.json({ ...manifest, tenant_id: randomUUID() }));
  await expect(client.process(payload, runId)).rejects.toThrow('PROCESSOR_REFERENCE_MISMATCH');
  manifest.artifacts[0]!.key = 'other-tenant/secret.jsonl.gz';
  vi.stubGlobal('fetch', async () => Response.json(manifest));
  await expect(client.process(payload, runId)).rejects.toThrow('PROCESSOR_REFERENCE_MISMATCH');
});

it('detects compressed artifact tampering before parsing any source evidence', async () => {
  const { compressed, manifest } = fixture();
  compressed[10] = compressed[10]! ^ 1;
  vi.stubGlobal('fetch', async () => new Response(compressed));
  await expect(collect(manifest)).rejects.toThrow('ARTIFACT_CHECKSUM_MISMATCH');
});

it('bounds decompression even when compressed bytes match the manifest checksum', async () => {
  const { compressed, manifest } = fixture();
  manifest.artifacts[0]!.uncompressed_bytes = 10;
  vi.stubGlobal('fetch', async () => new Response(compressed));
  await expect(collect(manifest)).rejects.toThrow('INVALID_ARTIFACT_COMPRESSION');
});

it('rejects a valid JSON record referring to a different document', async () => {
  const { record, manifest } = fixture();
  record.document_id = randomUUID();
  const content = Buffer.from(JSON.stringify(record) + '\n');
  const compressed = gzipSync(content);
  Object.assign(manifest.artifacts[0]!, { size_bytes: compressed.length, uncompressed_bytes: content.length,
    sha256: createHash('sha256').update(compressed).digest('hex') });
  vi.stubGlobal('fetch', async () => new Response(compressed));
  await expect(collect(manifest)).rejects.toThrow('ARTIFACT_REFERENCE_MISMATCH');
});

it('distinguishes permanent rejection from retryable processor outages without reflecting server text', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'CORRUPT_FILE' } }, { status: 422 }));
  await expect(client.process(payload, runId)).rejects.toMatchObject({ code: 'CORRUPT_FILE', permanent: true });
  vi.stubGlobal('fetch', async () => new Response('private internal error', { status: 503 }));
  await expect(client.process(payload, runId)).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE', permanent: false });
});
