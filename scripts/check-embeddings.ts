import { it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalEmbeddingClient, loadEnvironment, validEmbedding, embeddingSpace } from '@doc/core';
const environment = loadEnvironment(), client = new LocalEmbeddingClient(environment), tenant = randomUUID(), document = randomUUID();
const texts = ['Invoice for paper, pens and school notebooks.', 'বাংলাদেশের স্কুলের জন্য কাগজ কলম ও খাতা কেনার চালান।'];
it('creates real structure-aware English/Bengali chunks through authenticated local HTTP', async () => {
  const chunks = await client.chunks(tenant, document, texts.map((text, index) => ({ unit_id: 'synthetic-' + index, invoice_id: null, page_number: index + 1, worksheet: null, cell_range: null, section: 'Synthetic bilingual invoice', kind: 'text', text })));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => chunk.token_count <= environment.CHUNK_MAX_TOKENS));
});
it('generates normalized real Qwen document and instructed query embeddings locally', async () => {
  const documents = await client.embed(tenant, texts, 'document'), queries = await client.embed(tenant, ['school stationery invoice'], 'query');
  assert.equal(documents.length, 2);
  assert.equal(queries.length, 1);
  assert.ok([...documents, ...queries].every(validEmbedding));
});
it('reports the selected immutable production model identity without remote inference', async () => {
  const response = await fetch('http://' + environment.PROCESSOR_HOST + ':' + environment.PROCESSOR_PORT + '/internal/capabilities', { headers: { authorization: 'Bearer ' + environment.PROCESSOR_INTERNAL_TOKEN }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const data = z.object({ embeddings: z.object({ model_id: z.string(), model_version: z.string(), local_only: z.boolean() }) }).parse(await response.json()), space = embeddingSpace(environment);
  assert.equal(data.embeddings.model_id, space.model_id);
  assert.equal(data.embeddings.model_version, space.model_version);
  assert.equal(data.embeddings.local_only, true);
});
