import { expect, it } from 'vitest';
import { healthResponseSchema, foundationJobSchema } from '../src/index.js';

it('rejects unsupported health statuses and unexpected response fields', () => {
  const base = { service: 'api', status: 'ok', timestamp: new Date().toISOString() };
  expect(healthResponseSchema.safeParse(base).success).toBe(true);
  expect(healthResponseSchema.safeParse({ ...base, status: 'probably' }).success).toBe(false);
  expect(healthResponseSchema.safeParse({ ...base, password: 'unexpected' }).success).toBe(false);
});

it('requires an ISO timestamp for operational queue jobs', () => {
  expect(foundationJobSchema.safeParse({ requestedAt: 'tomorrow' }).success).toBe(false);
  expect(foundationJobSchema.safeParse({ requestedAt: new Date().toISOString(), document: 'unexpected' }).success).toBe(false);
});
