import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/env.js';

const valid = {
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'document_intelligence', POSTGRES_USER: 'local',
  POSTGRES_PASSWORD: 'test-only-password-not-a-secret',
  POSTGRES_APP_PASSWORD: 'test-only-password-not-a-secret',
  POSTGRES_DISPATCHER_PASSWORD: 'test-only-password-not-a-secret',
  
  PROCESSOR_INTERNAL_TOKEN: 'test-only-password-not-a-secret',
  REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'test-only-password-not-a-secret',
  S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'documents',
  S3_ACCESS_KEY: 'test-only-access-key', S3_SECRET_KEY: 'test-only-password-not-a-secret',
};

describe('environment validation', () => {
  it('coerces ports and applies local defaults', () => {
    const environment = parseEnvironment({ ...valid, API_PORT: '3101' });
    expect(environment.API_PORT).toBe(3101);
    expect(environment.API_HOST).toBe('127.0.0.1');
    expect(environment.POSTGRES_PORT).toBe(55432);
  });
  it.each(['0', '65536', 'abc', '2.5'])('rejects invalid port %s', (port) => {
    expect(() => parseEnvironment({ ...valid, API_PORT: port })).toThrow('API_PORT');
  });
  it('rejects unconfigured secrets', () => {
    expect(() => parseEnvironment({ ...valid, POSTGRES_PASSWORD: 'REPLACE_WITH_GENERATED_POSTGRES_PASSWORD' })).toThrow('POSTGRES_PASSWORD');
  });
  it('requires explicit key/model configuration before enabling Gemini segmentation advice', () => {
    expect(parseEnvironment(valid).SEGMENTATION_AI_ENABLED).toBe(false);
    expect(() => parseEnvironment({ ...valid, SEGMENTATION_AI_ENABLED: 'true' })).toThrow('GEMINI_API_KEY');
  });
  it('identifies invalid fields without exposing submitted values', () => {
    expect(() => parseEnvironment({ ...valid, S3_SECRET_KEY: 'private' })).toThrow('S3_SECRET_KEY');
    expect(() => parseEnvironment({ ...valid, S3_SECRET_KEY: 'private' })).not.toThrow('private');
  });
});
