import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') throw new Error('Expected dev or start');
const port = Number(process.env.WEB_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEB_PORT');
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), mode, '--hostname', process.env.WEB_HOST ?? '127.0.0.1', '--port', String(port)], {
  cwd: join(root, 'apps/web'), stdio: 'inherit',
  env: { ...process.env, NODE_ENV: mode === 'start' ? 'production' : 'development' },
});
child.on('error', () => { console.error('Could not start Next.js'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1; });
