import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const secret = z.string().min(20).refine((value) => !value.startsWith('REPLACE_'), 'Generate local credentials first');
const hostname = z.string().min(1).refine((value) => !/[\s/@]/.test(value));

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: hostname.default('127.0.0.1'),
  API_PORT: port.default(3001),
  WORKER_HOST: hostname.default('127.0.0.1'),
  WORKER_PORT: port.default(3002),
  WORKFLOW_ENABLED: z.enum(['true','false']).default('true').transform(value=>value==='true'),
  WEB_HOST: hostname.default('127.0.0.1'),
  WEB_PORT: port.default(3000),
  PROCESSOR_HOST: hostname.default('127.0.0.1'),
  PROCESSOR_PORT: port.default(8000),
  POSTGRES_HOST: hostname,
  POSTGRES_PORT: port.default(55432),
  POSTGRES_DB: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: secret,
  POSTGRES_APP_USER: z.literal('document_intelligence_app').default('document_intelligence_app'),
  POSTGRES_APP_PASSWORD: secret,
  POSTGRES_DISPATCHER_PASSWORD: secret,
  LOCAL_WORKSPACE_TENANT_ID: z.uuid().default('11111111-1111-4111-8111-111111111111'),
  LOCAL_WORKSPACE_USER_ID: z.uuid().default('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  PROCESSOR_INTERNAL_TOKEN: secret,
  UPLOAD_MAX_FILES: z.coerce.number().int().min(1).max(100).default(10),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().min(1).max(1_073_741_824).default(52_428_800),
  UPLOAD_MAX_BATCH_BYTES: z.coerce.number().int().min(1).max(2_147_483_648).default(104_857_600),
  UPLOAD_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(1_000),
  UPLOAD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(4),
  UPLOAD_LEASE_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  INSPECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  SEGMENTATION_AI_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SEGMENTATION_AI_MAX_CALLS: z.coerce.number().int().min(1).max(10).default(5),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_SEGMENTATION_MODEL: z.string().max(100).default(''),
  CLOUD_LLM_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  EXTRACTION_AUTO_START: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  GEMINI_MODEL: z.string().max(100).default(''),
  LOCAL_LLM_BASE_URL: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
  LOCAL_LLM_MODEL: z.string().max(128).default(''),
  LOCAL_LLM_MODEL_VERSION: z.string().max(128).default(''),
  LOCAL_LLM_ALLOWED_HOSTS: z.string().max(512).default('localhost,127.0.0.1,::1'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(180_000).default(60_000),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
  LLM_RETRY_BASE_MS: z.coerce.number().int().min(10).max(10_000).default(500),
  LLM_RETRY_MAX_MS: z.coerce.number().int().min(10).max(30_000).default(5_000),
  LLM_CIRCUIT_FAILURES: z.coerce.number().int().min(1).max(10).default(3),
  LLM_CIRCUIT_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  EXTRACTION_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(100_000).default(32_000),
  EMBEDDINGS_ENABLED:z.enum(['true','false']).default('true').transform(value=>value==='true'),
  EMBEDDING_MODEL_ID:z.enum(['Qwen/Qwen3-Embedding-0.6B','microsoft/harrier-oss-v1-0.6b']).default('Qwen/Qwen3-Embedding-0.6B'),
  EMBEDDING_MODEL_VERSION:z.string().regex(/^[a-f0-9]{40}$/).default('97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'),
  EMBEDDING_DIMENSIONS:z.coerce.number().refine(value=>value===1024,'The current PostgreSQL vector schema requires 1024 dimensions').default(1024),
  EMBEDDING_QUERY_INSTRUCTION:z.string().min(1).max(500).default('Given an invoice or business document search query, retrieve relevant passages that answer the query'),
  EMBEDDING_MAX_TOKENS:z.coerce.number().int().min(1024).max(8192).default(2048),
  EMBEDDING_TIMEOUT_MS:z.coerce.number().int().min(1000).max(300000).default(120000),
  CHUNK_TARGET_TOKENS:z.coerce.number().int().min(100).max(600).default(450),
  CHUNK_MAX_TOKENS:z.coerce.number().int().min(100).max(1000).default(600),
  INDEX_MAX_CHUNKS:z.coerce.number().int().min(1).max(50000).default(10000),
  S3_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  INGESTION_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  INGESTION_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_MAX_FAILURES: z.coerce.number().int().min(1).max(30).default(10),
  OUTBOX_RECHECK_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  ANTIVIRUS_MODE: z.enum(['disabled', 'clamav']).default('disabled'),
  CLAMAV_HOST: hostname.default('127.0.0.1'),
  CLAMAV_PORT: port.default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  REDIS_HOST: hostname,
  REDIS_PORT: port.default(6379),
  REDIS_PASSWORD: secret,
  QUEUE_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('document-intelligence'),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  S3_ACCESS_KEY: z.string().min(8).refine((value) => !value.startsWith('REPLACE_')),
  S3_SECRET_KEY: secret,
}).superRefine((value, context) => {
  if(value.CHUNK_TARGET_TOKENS>value.CHUNK_MAX_TOKENS)context.addIssue({code:'custom',path:['CHUNK_MAX_TOKENS'],message:'Maximum must cover the target'});
  if (value.SEGMENTATION_AI_ENABLED && (value.GEMINI_API_KEY.length < 20 || !/^gemini-[a-zA-Z0-9._-]+$/.test(value.GEMINI_SEGMENTATION_MODEL))) {
    context.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'Configure Gemini key and model before enabling cloud advice' });
  }
  if (value.CLOUD_LLM_ENABLED && (value.GEMINI_API_KEY.length < 20 || !/^gemini-[a-zA-Z0-9._-]+$/.test(value.GEMINI_MODEL))) context.addIssue({ code: 'custom', path: ['GEMINI_MODEL'], message: 'Configure Gemini extraction before enabling cloud use' });
  if (Boolean(value.LOCAL_LLM_BASE_URL) !== Boolean(value.LOCAL_LLM_MODEL)) context.addIssue({ code: 'custom', path: ['LOCAL_LLM_BASE_URL'], message: 'Configure both local endpoint and model' });
  if (value.LOCAL_LLM_BASE_URL) {
    const url = new URL(value.LOCAL_LLM_BASE_URL);
    if (url.username || url.password || url.search || url.hash) context.addIssue({ code: 'custom', path: ['LOCAL_LLM_BASE_URL'], message: 'Endpoint must not contain credentials, query or fragment' });
    if (!/qwen/i.test(value.LOCAL_LLM_MODEL) || /cloud/i.test(value.LOCAL_LLM_MODEL)) context.addIssue({ code: 'custom', path: ['LOCAL_LLM_MODEL'], message: 'Use a locally hosted Qwen model identifier' });
  }
});

export type RuntimeEnvironment = z.infer<typeof environmentSchema>;

export function projectRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let directory = start;
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const content = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (content.name === 'document-intelligence') return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the document-intelligence workspace');
    directory = parent;
  }
}

export function parseEnvironment(input: NodeJS.ProcessEnv): RuntimeEnvironment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error('Invalid environment variables: ' + fields.join(', ') + '. Run npm run setup:env.');
  }
  return result.data;
}

export function loadEnvironment(): RuntimeEnvironment {
  config({ path: join(projectRoot(), '.env'), quiet: true });
  return parseEnvironment(process.env);
}
