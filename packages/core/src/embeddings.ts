import { createHash } from 'node:crypto';
import { chunkResponseSchema, embeddingResponseSchema, embeddingSpaceSchema, QWEN_EMBEDDING_ID } from '@doc/contracts';
import type { ChunkUnit, EmbeddingSpace, PreparedChunk } from '@doc/contracts';
import type { RuntimeEnvironment } from './env.js';
import { ServiceError } from './errors.js';
export function embeddingSpace(env: RuntimeEnvironment): EmbeddingSpace {
  const config = {
    model_id: env.EMBEDDING_MODEL_ID, model_version: env.EMBEDDING_MODEL_VERSION, dimensions: env.EMBEDDING_DIMENSIONS,
    adapter: env.EMBEDDING_MODEL_ID === QWEN_EMBEDDING_ID ? 'qwen3-last-token-v1' : 'harrier-last-token-v1', query_instruction: env.EMBEDDING_QUERY_INSTRUCTION,
    maximum_tokens: env.EMBEDDING_MAX_TOKENS, chunker_version: 'structure-qwen-tokenizer-v1', source_builder_version: 'normalized-invoice-records-v1', target_tokens: env.CHUNK_TARGET_TOKENS, maximum_chunk_tokens: env.CHUNK_MAX_TOKENS
  };
  return embeddingSpaceSchema.parse({ ...config, space_id: createHash('sha256').update(JSON.stringify(config)).digest('hex') });
}
export function validEmbedding(vector: number[]): boolean {
  const norm = vector.reduce((sum, value) => sum + value * value, 0);
  return vector.length === 1024 && vector.every(Number.isFinite) && Math.abs(norm - 1) < 0.002;
}
export interface EmbeddingClient {
  chunks(tenant: string, document: string, units: ChunkUnit[]): Promise<PreparedChunk[]>;
  embed(tenant: string, texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}
export class LocalEmbeddingClient implements EmbeddingClient {
  readonly space: EmbeddingSpace;
  constructor(private readonly env: RuntimeEnvironment) { this.space = embeddingSpace(env); }
  private async request(path: string, body: unknown) {
    if (!this.env.EMBEDDINGS_ENABLED)
      throw new ServiceError('EMBEDDINGS_DISABLED', 503, 'Local embeddings are disabled.');
    let response: Response;
    try {
      response = await fetch('http://' + this.env.PROCESSOR_HOST + ':' + this.env.PROCESSOR_PORT + path, { method: 'POST', headers: { authorization: 'Bearer ' + this.env.PROCESSOR_INTERNAL_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.env.EMBEDDING_TIMEOUT_MS) });
    }
    catch {
      throw new ServiceError('EMBEDDER_UNAVAILABLE', 503, 'Local embedding service unavailable.');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body)
      throw new ServiceError('EMBEDDER_INVALID_RESPONSE', 502, 'Missing embedding response.');
    const reader = response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done)
          break;
        size += item.value.length;
        if (size > 4194304)
          throw new ServiceError('EMBEDDER_RESPONSE_LIMIT', 502, 'Embedding response exceeded its limit.');
        chunks.push(item.value);
      }
    }
    finally {
      await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok)
      throw new ServiceError(response.status < 500 ? 'EMBEDDER_INPUT_REJECTED' : 'EMBEDDER_UNAVAILABLE', response.status < 500 ? 422 : 503, 'Local embedding request did not complete.');
    return value;
  }
  async chunks(tenant: string, document: string, units: ChunkUnit[]): Promise<PreparedChunk[]> {
    if (Buffer.byteLength(JSON.stringify(units)) > 500000) {
      const middle = Math.floor(units.length / 2);
      if (!middle)
        throw new ServiceError('CHUNK_SOURCE_LIMIT', 422, 'Source unit exceeds the request limit.');
      return [...await this.chunks(tenant, document, units.slice(0, middle)), ...await this.chunks(tenant, document, units.slice(middle))];
    }
    const result = chunkResponseSchema.parse(await this.request('/internal/chunks', { tenant_id: tenant, document_id: document, units, target_tokens: this.env.CHUNK_TARGET_TOKENS, maximum_tokens: this.env.CHUNK_MAX_TOKENS }));
    if (result.chunks.some(chunk => chunk.token_count > this.env.CHUNK_MAX_TOKENS))
      throw new ServiceError('CHUNK_LIMIT_VIOLATION', 502, 'Chunk token limit exceeded.');
    return result.chunks;
  }
  async embed(tenant: string, texts: string[], kind: 'query' | 'document') {
    const result = embeddingResponseSchema.parse(await this.request('/internal/embeddings', { tenant_id: tenant, model_id: this.space.model_id, model_version: this.space.model_version, dimensions: this.space.dimensions, kind, texts, query_instruction: this.space.query_instruction }));
    if (result.model_id !== this.space.model_id || result.model_version !== this.space.model_version || result.adapter !== this.space.adapter || result.vectors.length !== texts.length || !result.vectors.every(validEmbedding))
      throw new ServiceError('EMBEDDING_SPACE_MISMATCH', 502, 'Embedding identity or vector validation failed.');
    return result.vectors;
  }
}
