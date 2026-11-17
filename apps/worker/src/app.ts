import { Worker } from 'bullmq';
import { FOUNDATION_QUEUE } from '@doc/contracts';
import { buildHealthApp, createDocumentQueues, createObjectStorage, createRedis } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { checkDatabase, createDatabasePool, createDispatcherPool } from '@doc/database';
import { processFoundationJob } from './processor.js';
import { IngestionProcessor } from './ingestion.js';
import { IngestionOutbox } from './outbox.js';
import { InvoiceExtractionProcessor } from './extraction/processor.js';
import type { InvoiceProviders } from './extraction/processor.js';
import { IndexingProcessor } from './indexing.js';
import { WorkflowRunner } from './workflow.js';
import type { EmbeddingClient } from '@doc/core';

export function buildWorker(environment: RuntimeEnvironment, options: { extractionProviders?: InvoiceProviders; extractionWait?: (ms: number) => Promise<void>;embeddingClient?:EmbeddingClient } = {}) {
  const database = createDatabasePool(environment);
  const dispatcherDatabase = createDispatcherPool(environment);
  const redis = createRedis(environment);
  const workerRedis = createRedis(environment, true);
  const documentRedis = createRedis(environment, true);
  const extractionRedis = createRedis(environment, true);
  const indexingRedis=createRedis(environment,true);
  const queues = createDocumentQueues(environment);
  const storage = createObjectStorage(environment, environment.S3_OPERATION_TIMEOUT_MS);
  const processor = new IngestionProcessor(database, storage, environment);
  const worker = new Worker(FOUNDATION_QUEUE, processFoundationJob, {
    connection: workerRedis, prefix: environment.QUEUE_PREFIX, concurrency: 1,
    removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
  });
  const documents = new Worker('document-queue', (job, token) => processor.process(job, token), {
    connection: documentRedis, prefix: environment.QUEUE_PREFIX, concurrency: 2,
    removeOnComplete: { count: 1_000, age: 86_400 }, removeOnFail: { count: 1_000, age: 604_800 },
  });
  const extractor = new InvoiceExtractionProcessor(database, environment, options.extractionProviders, options.extractionWait);
  const extractions = new Worker('extraction-queue', (job, token) => extractor.process(job, token), {
    connection: extractionRedis, prefix: environment.QUEUE_PREFIX, concurrency: 1,
    removeOnComplete: { count: 1000, age: 86_400 }, removeOnFail: { count: 1000, age: 604_800 },
  });
  const app = buildHealthApp({
    service: 'worker', logLevel: environment.LOG_LEVEL,
    checks: {
      postgres: () => checkDatabase(database),
      understanding: async () => { await database.query('SELECT id FROM public.document_understanding_runs LIMIT 0'); },
      extraction: async () => { await database.query('SELECT id FROM public.extraction_attempts LIMIT 0'); },
      redis: async () => { if (await redis.ping() !== 'PONG') throw new Error('Redis unavailable'); },
      processor: async () => {
        const response = await fetch('http://' + environment.PROCESSOR_HOST + ':' + environment.PROCESSOR_PORT + '/health/ready', { signal: AbortSignal.timeout(3_000) });
        try { if (!response.ok) throw new Error('Document processor unavailable'); }
        finally { await response.body?.cancel(); }
      },
      consumer: async () => {
        if (workerRedis.status !== 'ready' || documentRedis.status !== 'ready' || extractionRedis.status !== 'ready' || indexingRedis.status!=='ready'||!worker.isRunning() || !documents.isRunning()
          || !extractions.isRunning() || !indexing.isRunning()||worker.isPaused() || documents.isPaused() || extractions.isPaused()||indexing.isPaused()) throw new Error('Consumer unavailable');
      },
      dispatcher: async () => {
        const result = await dispatcherDatabase.query<{ ready: boolean }>("SELECT to_regprocedure('public.claim_ingestion_dispatches(integer,integer)') IS NOT NULL AS ready");
        if (!result.rows[0]?.ready) throw new Error('Dispatcher migration unavailable');
      },
    },
  });
  const indexer=new IndexingProcessor(database,environment,options.embeddingClient);
  const indexing=new Worker('indexing-queue',(job,token)=>indexer.process(job,token),{connection:indexingRedis,prefix:environment.QUEUE_PREFIX,concurrency:1,removeOnComplete:{count:1000,age:86400},removeOnFail:{count:1000,age:604800}});
  const dispatcher = new IngestionOutbox(dispatcherDatabase, queues.queues, environment, () => app.log.warn('Durable queue dispatch unavailable; retry state is retained in PostgreSQL'));
  const workflow = new WorkflowRunner(database,dispatcherDatabase,environment,()=>app.log.warn('Durable workflow unavailable; PostgreSQL retains recovery state'));
  for (const consumer of [worker, documents, extractions,indexing]) {
    consumer.on('failed', () => app.log.warn('Background job failed; authoritative job state is in PostgreSQL'));
    consumer.on('error', () => app.log.warn('Worker connection unavailable'));
  }
  app.addHook('onReady', async () => { dispatcher.start(); workflow.start(); });
  app.addHook('onClose', async () => {
    await workflow.stop();
    await dispatcher.stop();
    await Promise.all([worker.close(), documents.close(), extractions.close(),indexing.close()]);
    await queues.close();
    redis.disconnect(); workerRedis.disconnect(); documentRedis.disconnect(); extractionRedis.disconnect();indexingRedis.disconnect(); storage.destroy();
    await Promise.all([database.end(), dispatcherDatabase.end()]);
  });
  return { app, dispatcher, workflow, documents, extractions,indexing, queues: queues.queues };
}
