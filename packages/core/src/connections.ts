import { Redis } from 'ioredis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { RuntimeEnvironment } from './env.js';

export function createRedis(environment: RuntimeEnvironment, worker = false): Redis {
  const redis = new Redis({
    host: environment.REDIS_HOST,
    port: environment.REDIS_PORT,
    password: environment.REDIS_PASSWORD,
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 2_000,
    ...(worker ? {} : { commandTimeout: 3_000 }),
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  // Individual operations and readiness report errors without logging credentials.
  redis.on('error', () => undefined);
  return redis;
}

export function createObjectStorage(environment: RuntimeEnvironment, requestTimeout = 3_000): S3Client {
  return new S3Client({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: environment.S3_ACCESS_KEY,
      secretAccessKey: environment.S3_SECRET_KEY,
    },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2_000, requestTimeout },
  });
}

export async function checkObjectStorage(client: S3Client, bucket: string): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}
