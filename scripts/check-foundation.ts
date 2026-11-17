import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { FOUNDATION_JOB, FOUNDATION_QUEUE, foundationJobResultSchema, healthResponseSchema, systemHealthResponseSchema } from '@doc/contracts';
import { createObjectStorage, createRedis, loadEnvironment } from '@doc/core';
import { checkDatabase, createDatabasePool } from '@doc/database';

const environment = loadEnvironment();
const database = createDatabasePool(environment);
const redis = createRedis(environment);
const storage = createObjectStorage(environment);
try {
  await test('PostgreSQL authentication, pgvector extension, and vector operations', async () => {
    await checkDatabase(database);
    const result = await database.query<{ distance: number }>("SELECT '[1,0,0]'::vector <=> '[0,1,0]'::vector AS distance");
    assert.equal(result.rows[0]?.distance, 1);
  });

  await test('Authenticated Redis read/write with bounded lifetime', async () => {
    if (redis.status !== 'ready') await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis readiness timeout')), 5_000);
      redis.once('ready', () => { clearTimeout(timer); resolve(); });
    });
    const key = environment.QUEUE_PREFIX + ':test:' + randomUUID();
    try {
      assert.equal(await redis.ping(), 'PONG');
      await redis.set(key, 'foundation-check', 'EX', 30);
      assert.equal(await redis.get(key), 'foundation-check');
    } finally { await redis.del(key); }
  });

  await test('MinIO allows authenticated object access and denies anonymous access', async () => {
    const key = '_foundation-check/' + randomUUID() + '.txt';
    try {
      await storage.send(new PutObjectCommand({ Bucket: environment.S3_BUCKET, Key: key, Body: 'foundation-check', ContentType: 'text/plain' }));
      const object = await storage.send(new GetObjectCommand({ Bucket: environment.S3_BUCKET, Key: key }));
      assert.equal(await object.Body?.transformToString(), 'foundation-check');
      const url = environment.S3_ENDPOINT + '/' + environment.S3_BUCKET + '/' + key;
      const anonymous = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      assert.equal(anonymous.status, 403);
      await anonymous.body?.cancel();
    } finally {
      await storage.send(new DeleteObjectCommand({ Bucket: environment.S3_BUCKET, Key: key }));
    }
  });

  for (const [service, host, port] of [
    ['api', environment.API_HOST, environment.API_PORT],
    ['worker', environment.WORKER_HOST, environment.WORKER_PORT],
    ['document-processor', environment.PROCESSOR_HOST, environment.PROCESSOR_PORT],
  ] as const) {
    await test(service + ' liveness and readiness over HTTP', async () => {
      for (const path of ['/health', '/health/ready']) {
        const response = await fetch('http://' + host + ':' + port + path, { signal: AbortSignal.timeout(8_000) });
        assert.equal(response.status, 200);
        const health = healthResponseSchema.parse(await response.json());
        assert.equal(health.service, service);
        assert.equal(health.status, 'ok');
      }
    });
  }

  await test('BullMQ job passes through the running worker', async () => {
    const queueConnection = createRedis(environment, true);
    const eventConnection = createRedis(environment, true);
    const queue = new Queue(FOUNDATION_QUEUE, { connection: queueConnection, prefix: environment.QUEUE_PREFIX });
    const events = new QueueEvents(FOUNDATION_QUEUE, { connection: eventConnection, prefix: environment.QUEUE_PREFIX });
    try {
      await Promise.race([
        events.waitUntilReady(),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Queue readiness timeout')), 5_000); timer.unref(); }),
      ]);
      const job = await queue.add(FOUNDATION_JOB, { requestedAt: new Date().toISOString() }, {
        jobId: randomUUID(), attempts: 3, backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: 100, removeOnFail: 100,
      });
      foundationJobResultSchema.parse(await job.waitUntilFinished(events, 8_000));
      await job.remove();
    } finally {
      await queue.close();
      await events.close();
      queueConnection.disconnect();
      eventConnection.disconnect();
    }
  });

  await test('Next.js serves the foundation page and web health response', async () => {
    const base = 'http://' + environment.WEB_HOST + ':' + environment.WEB_PORT;
    const page = await fetch(base, { signal: AbortSignal.timeout(30_000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Document Intelligence/);
    const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(healthResponseSchema.parse(await response.json()).service, 'web');
    const status = await fetch(base + '/api/system-health', { signal: AbortSignal.timeout(8_000) });
    assert.equal(status.status, 200);
    const snapshot = systemHealthResponseSchema.parse(await status.json());
    assert.equal(snapshot.services.length, 4);
    assert.ok(snapshot.services.every((service) => service.status === 'ok'));
  });
} finally {
  redis.disconnect();
  storage.destroy();
  await database.end();
}
