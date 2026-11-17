import { Queue } from 'bullmq';
import { DOCUMENT_QUEUES } from '@doc/contracts';
import type { RuntimeEnvironment } from './env.js';
import { createRedis } from './connections.js';

export function createDocumentQueues(environment: RuntimeEnvironment) {
  const connection = createRedis(environment);
  const queues = new Map(DOCUMENT_QUEUES.map((name) => {
    const queue = new Queue(name, {
      connection, prefix: environment.QUEUE_PREFIX,
      skipWaitingForReady: true,
      // Producers must survive startup while Redis is down. Consumers perform
      // the normal server-version check; local Redis is also image-pinned.
      skipVersionCheck: true,
      defaultJobOptions: {
        attempts: environment.INGESTION_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: environment.INGESTION_BACKOFF_MS },
        removeOnComplete: { count: 1_000, age: 86_400 },
        removeOnFail: { count: 1_000, age: 604_800 },
      },
    });
    queue.on('error', () => undefined);
    return [name, queue] as const;
  }));
  connection.on('ready', () => {
    for (const queue of queues.values()) {
      void queue.client.then((client) => client.hset(queue.toKey('meta'), queue.metaValues)).catch(() => undefined);
    }
  });
  return {
    queues,
    async close() { try { await Promise.all([...queues.values()].map((queue) => queue.close())); } finally { connection.disconnect(); } },
  };
}
