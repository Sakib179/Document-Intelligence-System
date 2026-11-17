import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const target = fileURLToPath(new URL('../.env', import.meta.url));
const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const generated = example
  .replace('REPLACE_WITH_GENERATED_POSTGRES_PASSWORD', randomBytes(32).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_APP_PASSWORD', randomBytes(32).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_DISPATCHER_PASSWORD', randomBytes(32).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_PROCESSOR_TOKEN', randomBytes(32).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_REDIS_PASSWORD', randomBytes(32).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_S3_ACCESS_KEY', 'di_local_' + randomBytes(12).toString('hex'))
  .replace('REPLACE_WITH_GENERATED_S3_SECRET_KEY', randomBytes(32).toString('hex'));
try {
  await writeFile(target, generated, { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
  console.log('Created private root .env with random local credentials. Existing Python environment is unchanged.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const current = await readFile(target, 'utf8');
  const existing = parse(current);
  const missing = generated.split('\n').filter((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    return key && !Object.hasOwn(existing, key);
  });
  if (missing.length > 0) {
    await writeFile(target, current.trimEnd() + '\n' + missing.join('\n') + '\n', { mode: 0o600 });
    console.log('Added ' + missing.length + ' missing environment keys; existing values and credentials preserved.');
  } else console.log('Root .env already exists; preserved without changes.');
  await chmod(target, 0o600);
}
