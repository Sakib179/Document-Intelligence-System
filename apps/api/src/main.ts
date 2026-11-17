import { installShutdown, loadEnvironment } from '@doc/core';
import { buildApi } from './app.js';

try {
  const environment = loadEnvironment();
  const app = buildApi(environment);
  installShutdown(() => app.close());
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid environment') ? error.message : 'API startup failed');
  process.exit(1);
}
