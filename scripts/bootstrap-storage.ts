import { CreateBucketCommand, DeleteBucketPolicyCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { createObjectStorage, loadEnvironment } from '@doc/core';

const environment = loadEnvironment();
const storage = createObjectStorage(environment);
try {
  try {
    await storage.send(new HeadBucketCommand({ Bucket: environment.S3_BUCKET }));
  } catch (error) {
    const metadata = error as { $metadata?: { httpStatusCode?: number } };
    if (metadata.$metadata?.httpStatusCode !== 404) throw error;
    await storage.send(new CreateBucketCommand({ Bucket: environment.S3_BUCKET }));
  }
  // This dedicated development bucket must never have an anonymous access policy.
  await storage.send(new DeleteBucketPolicyCommand({ Bucket: environment.S3_BUCKET }));
  await storage.send(new HeadBucketCommand({ Bucket: environment.S3_BUCKET }));
  console.log('Private document bucket is ready. Anonymous access policy is absent.');
} catch {
  console.error('Private bucket initialization failed. Check MinIO readiness and root .env configuration.');
  process.exitCode = 1;
} finally {
  storage.destroy();
}
