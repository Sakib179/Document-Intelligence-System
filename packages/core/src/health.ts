import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import { healthResponseSchema } from '@doc/contracts';
import type { CheckResult, ServiceName } from '@doc/contracts';

export type HealthChecks = Record<string, () => Promise<void>>;

export async function runHealthChecks(checks: HealthChecks): Promise<Record<string, CheckResult>> {
  const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    try {
      await check();
      return [name, { status: 'ok' }] as const;
    } catch {
      return [name, { status: 'error' }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

export function buildHealthApp(options: {
  service: Extract<ServiceName, 'api' | 'worker'>;
  checks: HealthChecks;
  logLevel?: string;
  logger?: false;
  requestTimeout?: number;
  defaultErrorHandler?: boolean;
}) {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: options.logLevel ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'secret', 'token'],
    },
    requestTimeout: options.requestTimeout ?? 10_000,
    bodyLimit: 16_384,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(helmet);

  const querystring = { type: 'object', properties: {}, additionalProperties: false } as const;
  app.get('/health', { schema: { querystring } }, async () => healthResponseSchema.parse({
    service: options.service,
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));
  app.get('/health/ready', { schema: { querystring } }, async (_request, reply) => {
    const checks = await runHealthChecks(options.checks);
    const healthy = Object.values(checks).every((result) => result.status === 'ok');
    return reply.code(healthy ? 200 : 503).send(healthResponseSchema.parse({
      service: options.service,
      status: healthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks,
    }));
  });
  if (options.defaultErrorHandler !== false) app.setErrorHandler((error, _request, reply) => {
    const invalid = typeof error === 'object' && error !== null && (
      'validation' in error || ('statusCode' in error && error.statusCode === 400)
    );
    reply.code(invalid ? 400 : 500).send({ error: invalid ? 'Invalid request' : 'Internal server error' });
  });
  return app;
}
