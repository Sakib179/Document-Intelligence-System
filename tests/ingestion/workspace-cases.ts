import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { buildApi } from '../fixtures/workspace-api.js';
import { buildApi as productionApi } from '../../apps/api/src/app.js';
import type { EmbeddingClient, RuntimeEnvironment } from '@doc/core';
export interface WorkspaceResources {
  environment: RuntimeEnvironment;
  database: pg.Pool;
  fixtures: string;
  workspace: string;
  otherWorkspace: string;
  readerWorkspace: string;
  query: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
  waitFor: (predicate: () => Promise<boolean>, timeout?: number) => Promise<void>;
}
export const browserEmbedding: EmbeddingClient = { async chunks(_tenant, _doc, units) { return units.map(unit => ({ chunk_text: unit.text, token_count: 50, invoice_id: unit.invoice_id, page_number: unit.page_number, worksheet: unit.worksheet, section: unit.section, source_references: [{ page_number: unit.page_number, cell_range: unit.cell_range }] })); }, async embed(_tenant, texts) { return texts.map(() => [1, ...Array(1023).fill(0)]); } };
export function registerWorkspaceTests(resources: () => WorkspaceResources) {
  describe('frontend workspace backend contracts', () => {
    let r: WorkspaceResources, api: ReturnType<typeof buildApi>, doc: string;
    const get = (path: string, workspace?: string) => api.inject({ url: '/api/v1/' + path, headers: { 'x-test-workspace':  (workspace ?? r.workspace) } });
    before(async () => { r = resources(); api = buildApi(r.environment, { embeddingClient: browserEmbedding }); await api.ready(); doc = (await r.query("SELECT id FROM public.documents WHERE mime_type='application/pdf' AND metadata#>>'{processing,sourceVersion}' IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0].id; });
    after(async () => { await api?.close(); });
    it('returns actual identity, tenant and configured upload limits', async () => { const response = await get('me'); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().role, (await r.query('SELECT role FROM public.users WHERE id=$1', [response.json().id])).rows[0].role); assert.equal(response.json().upload_limits.max_files, r.environment.UPLOAD_MAX_FILES); });
    it('ignores client identity headers and fails closed for a missing configured operator', async () => {
      const direct = productionApi(r.environment, { embeddingClient: browserEmbedding });
      try {
        const plain = await direct.inject('/api/v1/me');
        assert.equal(plain.statusCode, 200, plain.body);
        const forged = await direct.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer forged', 'x-tenant-id': r.otherWorkspace.split(':')[0]!, 'x-user-id': r.otherWorkspace.split(':')[1]!, 'x-test-workspace': r.otherWorkspace } });
        assert.equal(forged.statusCode, 200, forged.body);
        assert.deepEqual(forged.json(), plain.json());
      } finally { await direct.close(); }
      const missing = productionApi({ ...r.environment, LOCAL_WORKSPACE_USER_ID: '99999999-9999-4999-8999-999999999999' });
      try { assert.equal((await missing.inject('/api/v1/me')).statusCode, 503); }
      finally { await missing.close(); }
    });
    it('calculates real tenant aggregates and processing activity', async () => { const response = await get('dashboard'); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().counts.total, (await r.query('SELECT count(*)::integer AS count FROM public.documents')).rows[0].count); assert.ok(response.json().activity.length <= 10); const other = await get('dashboard', r.otherWorkspace); assert.ok(other.json().counts.total < response.json().counts.total); assert.ok(!other.json().activity.some((item: any) => item.document_id === doc)); });
    it('paginates enriched document rows with current validation results', async () => { const first = await get('workspace/documents?limit=1'); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().documents.length, 1); assert.ok(first.json().next_cursor); assert.ok('validation_status' in first.json().documents[0]); const next = await get('workspace/documents?limit=1&cursor=' + first.json().next_cursor); assert.notEqual(first.json().documents[0].id, next.json().documents[0].id); assert.equal((await get('workspace/documents?cursor=bad')).statusCode, 400); });
    it('filters processing state, filenames and actual extraction providers', async () => { const response = await get('workspace/documents?provider=local_qwen&limit=5'); assert.equal(response.statusCode, 200, response.body); assert.ok(response.json().documents.length); assert.ok(response.json().documents.every((item: any) => item.provider === 'local_qwen')); assert.deepEqual((await get('workspace/documents?q=impossible-filename-7af3')).json().documents, []); });
    it('returns active page OCR metadata, text and source blocks', async () => { const list = await get('documents/' + doc + '/pages'); assert.equal(list.statusCode, 200, list.body); assert.ok(list.json().pages.length); const response = await get('documents/' + doc + '/pages/1'); assert.equal(response.statusCode, 200, response.body); assert.ok('extracted_text' in response.json()); assert.ok('ocr_confidence' in response.json()); assert.ok(response.json().blocks.length <= 100); assert.equal((await get('documents/' + doc + '/pages/1', r.otherWorkspace)).statusCode, 404); });
    it('streams private originals and byte ranges only to authorized tenants', async () => { const response = await api.inject({ url: '/api/v1/documents/' + doc + '/content', headers: { 'x-test-workspace':  r.workspace, range: 'bytes=0-7' } }); assert.equal(response.statusCode, 206, response.body); assert.equal(response.rawPayload.length, 8); assert.equal(response.headers['content-type'], 'application/pdf'); assert.match(String(response.headers['cache-control']), /no-store/); assert.equal((await get('documents/' + doc + '/content', r.otherWorkspace)).statusCode, 404); });
    it('renders a private original PDF page as real PNG bytes', async () => { const response = await get('documents/' + doc + '/preview?page=1'); assert.equal(response.statusCode, 200, response.body.slice(0, 150)); assert.equal(response.headers['content-type'], 'image/png'); assert.deepEqual([...response.rawPayload.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal((await get('documents/' + doc + '/preview', r.otherWorkspace)).statusCode, 404); });
    it('preserves exact invoice currency and total filters on every search path', async () => {
      for (const mode of ['exact', 'filter', 'keyword', 'semantic', 'hybrid']) {
        const q = mode === 'exact' ? '&invoice_number=INV-101' : mode === 'filter' ? '' : '&q=Widget';
        const good = await get('search?mode=' + mode + q + '&currency=USD&amount_min=115&amount_max=115');
        assert.equal(good.statusCode, 200, good.body);
        assert.ok(good.json().items.length, mode);
        const wrong = await get('search?mode=' + mode + q + '&currency=BDT&amount_min=115&amount_max=115');
        assert.deepEqual(wrong.json().items, [], mode);
        assert.deepEqual((await get('search?mode=' + mode + q + '&currency=USD&amount_min=115&amount_max=115', r.otherWorkspace)).json().items, []);
      }
    });
    it('returns tenant-scoped reconciliation history and rejects invalid source queries', async () => {
      const response = await get('workspace/reconciliations?limit=1'); assert.equal(response.statusCode, 200, response.body); assert.ok(response.json().items.length); assert.deepEqual((await get('workspace/reconciliations', r.otherWorkspace)).json().items, []); for (const path of ['workspace/documents?limit=51', 'documents/' + doc + '/pages/0', 'documents/' + doc + '/preview?page=0'])
        assert.equal((await get(path)).statusCode, 400);
    });
  });
}
