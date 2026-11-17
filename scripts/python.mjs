import { config } from 'dotenv';
import { spawn, execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
config({ path: join(root, '.env'), quiet: true });
const interpreter = process.env.PYTHON_EXECUTABLE;
if (!interpreter || !isAbsolute(interpreter)) {
  throw new Error('Set PYTHON_EXECUTABLE in root .env to the existing Python Work (.venv) interpreter.');
}
const identity = JSON.parse(execFileSync(interpreter, ['-c', 'import sys,json; print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"base":sys.base_prefix}))'], { encoding: 'utf8' }));
if (identity.prefix === identity.base || identity.executable !== interpreter) {
  throw new Error('The configured interpreter must be the exact existing virtual-environment executable.');
}
const mode = process.argv[2];
const port = Number(process.env.PROCESSOR_PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PROCESSOR_PORT');
const service = join(root, 'services/document-processor');
const args = mode === 'test'
  ? ['-m', 'pytest', 'tests']
  : mode === 'embeddings-download'
    ? ['-m','document_processor.model_assets',...process.argv.slice(3)]
  : mode === 'evaluate'
    ? ['tests/evaluate_processing.py', '--output', join(root, 'docs/evaluation/processing-synthetic.json')]
  : mode === 'doctor'
    ? ['-c', 'import json; from document_processor.ocr import capabilities; print(json.dumps(capabilities(), indent=2))']
  : mode === 'serve' || mode === 'dev'
    ? ['-m', 'uvicorn', 'document_processor.main:app', '--app-dir', 'src', '--host', process.env.PROCESSOR_HOST ?? '127.0.0.1', '--port', String(port), ...(mode === 'dev' ? ['--reload', '--reload-dir', 'src'] : [])]
    : null;
if (!args) throw new Error('Expected dev, serve, test, evaluate, or doctor');
console.log('Using existing Python interpreter: ' + interpreter);
const child = spawn(interpreter, args, {
  cwd: service,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: join(service, 'src'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
});
child.on('error', () => { console.error('Could not start the existing Python interpreter'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = signal ? 0 : code ?? 1; });
