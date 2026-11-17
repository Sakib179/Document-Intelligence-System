import { installShutdown, loadEnvironment } from '@doc/core';
import { buildWorker } from './app.js';

try {
  const environment = loadEnvironment();
  const { app } = buildWorker(environment);
  installShutdown(() => app.close());
  await app.listen({ host: environment.WORKER_HOST, port: environment.WORKER_PORT });
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid environment') ? error.message : 'Worker startup failed');
  process.exit(1);
}
