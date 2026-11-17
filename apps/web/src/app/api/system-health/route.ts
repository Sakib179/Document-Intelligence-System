import { healthResponseSchema, systemHealthResponseSchema } from '@doc/contracts';
import type { HealthResponse } from '@doc/contracts';
import { loadEnvironment } from '@doc/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const environment = loadEnvironment();
    const targets = [
      { service: 'api', host: environment.API_HOST, port: environment.API_PORT },
      { service: 'worker', host: environment.WORKER_HOST, port: environment.WORKER_PORT },
      { service: 'document-processor', host: environment.PROCESSOR_HOST, port: environment.PROCESSOR_PORT },
    ] as const;
    const services: HealthResponse[] = await Promise.all(targets.map(async (target) => {
      try {
        const host = target.host === '0.0.0.0' ? '127.0.0.1' : target.host;
        const response = await fetch('http://' + host + ':' + target.port + '/health/ready', {
          cache: 'no-store', signal: AbortSignal.timeout(4_000),
        });
        const health = healthResponseSchema.parse(await response.json());
        if (health.service !== target.service || (response.ok && health.status !== 'ok') || (!response.ok && health.status !== 'error')) throw new Error('Invalid service status');
        return health;
      } catch {
        return { service: target.service, status: 'error' as const, timestamp: new Date().toISOString() };
      }
    }));
    services.push({ service: 'web', status: 'ok', timestamp: new Date().toISOString() });
    return Response.json(systemHealthResponseSchema.parse({ services, checkedAt: new Date().toISOString() }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'Service status is not configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
