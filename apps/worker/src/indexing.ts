import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type pg from 'pg';
import { indexingPayloadSchema } from '@doc/contracts';
import { IndexRepository, textDigest } from '@doc/database';
import { LocalEmbeddingClient, ServiceError } from '@doc/core';
import type { RuntimeEnvironment, EmbeddingClient } from '@doc/core';
export class IndexingProcessor {
  private readonly repository: IndexRepository;
  private readonly client: EmbeddingClient;
  constructor(database: pg.Pool, private readonly env: RuntimeEnvironment, client?: EmbeddingClient) { this.repository = new IndexRepository(database, env); this.client = client ?? new LocalEmbeddingClient(env); }
  async process(job: Job, queueToken?: string) {
    const payload = indexingPayloadSchema.parse(job.data);
    if (job.name !== 'index' || job.id !== payload.jobId)
      throw new UnrecoverableError('INVALID_INDEX_JOB');
    let token: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const claim = await this.repository.claim(payload);
      if ('done' in claim)
        return { stage: 'indexing_already_terminal' };
      if ('defer' in claim) {
        await job.moveToDelayed(claim.defer, queueToken);
        throw new DelayedError();
      }
      token = claim.token;
      heartbeat = setInterval(() => { void this.repository.heartbeat(payload, claim.token).catch(() => undefined); }, 30000);
      heartbeat.unref();
      let count = 0, hits = 0;
      for await (const units of this.repository.units(payload.tenantId, claim.run)) {
        const chunks = await this.client.chunks(payload.tenantId, payload.documentId, units);
        if (count + chunks.length > this.env.INDEX_MAX_CHUNKS)
          throw new ServiceError('INDEX_CHUNK_LIMIT', 422, 'Document exceeds the configured chunk limit.');
        for (let start = 0; start < chunks.length; start += 4) {
          const batch = chunks.slice(start, start + 4), cache = await this.repository.cached(payload.tenantId, batch.map(chunk => chunk.chunk_text));
          const missing = batch.filter(chunk => !cache.has(textDigest(chunk.chunk_text)));
          if (missing.length) {
            const vectors = await this.client.embed(payload.tenantId, missing.map(chunk => chunk.chunk_text), 'document');
            if (vectors.length !== missing.length)
              throw new ServiceError('INVALID_INDEX_VECTORS', 502, 'Embedding batch length mismatch.');
            missing.forEach((chunk, index) => cache.set(textDigest(chunk.chunk_text), vectors[index]!));
          }
          hits += batch.length - missing.length;
          await this.repository.append(payload, claim.run, claim.token, count + 1, batch, batch.map(chunk => cache.get(textDigest(chunk.chunk_text))!));
          count += batch.length;
        }
      }
      await this.repository.finish(payload, claim.run, claim.token, count, hits);
      return { stage: 'indexing_complete', chunks: count, cacheHits: hits };
    }
    catch (error) {
      if (error instanceof DelayedError)
        throw error;
      const code = error instanceof ServiceError ? error.code : 'INDEXING_UNAVAILABLE', permanent = error instanceof ServiceError && error.statusCode < 500;
      await this.repository.fail(payload, token, code, permanent);
      if (permanent)
        throw new UnrecoverableError(code);
      throw new Error(code);
    }
    finally {
      if (heartbeat)
        clearInterval(heartbeat);
    }
  }
}
