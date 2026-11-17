import { describe, expect, it, vi } from 'vitest';
import { buildHealthApp } from '../src/health.js';
import { healthResponseSchema } from '@doc/contracts';

describe('service health', () => {
  it('serves liveness without contacting dependencies', async () => {
    const check = vi.fn().mockRejectedValue(new Error('offline'));
    const app = buildHealthApp({ service: 'api', logger: false, checks: { database: check } });
    try {
      const response = await app.inject('/health');
      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json()).service).toBe('api');
      expect(check).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('reports all successful dependencies on readiness', async () => {
    const app = buildHealthApp({ service: 'worker', logger: false, checks: { redis: async () => undefined, consumer: async () => undefined } });
    try {
      const response = await app.inject('/health/ready');
      expect(response.statusCode).toBe(200);
      expect(response.json().checks).toEqual({ redis: { status: 'ok' }, consumer: { status: 'ok' } });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    } finally { await app.close(); }
  });

  it('returns 503 without disclosing dependency errors or credentials', async () => {
    const app = buildHealthApp({ service: 'api', logger: false, checks: {
      postgres: async () => { throw new Error('postgres://user:private-password@private-host'); },
      redis: async () => undefined,
    } });
    try {
      const response = await app.inject('/health/ready');
      expect(response.statusCode).toBe(503);
      expect(healthResponseSchema.parse(response.json()).status).toBe('error');
      expect(response.json().checks).toEqual({ postgres: { status: 'error' }, redis: { status: 'ok' } });
      expect(response.body).not.toContain('private-password');
      expect(response.body).not.toContain('private-host');
    } finally { await app.close(); }
  });

  it('rejects unsupported health query parameters', async () => {
    const app = buildHealthApp({ service: 'api', logger: false, checks: {} });
    try {
      const response = await app.inject('/health?unexpected=value');
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Invalid request' });
    } finally { await app.close(); }
  });
});
