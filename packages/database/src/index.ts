import pg from 'pg';
import type { RuntimeEnvironment } from '@doc/core';

export const APPLICATION_ROLE = 'document_intelligence_app';
export type PoolOptions = { database?: string; max?: number };

export function databasePoolConfig(environment: RuntimeEnvironment, options: PoolOptions = {}): pg.PoolConfig {
  return {
    host: environment.POSTGRES_HOST,
    port: environment.POSTGRES_PORT,
    database: options.database ?? environment.POSTGRES_DB,
    user: environment.POSTGRES_APP_USER,
    password: environment.POSTGRES_APP_PASSWORD,
    max: options.max ?? 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 3_000,
    idle_in_transaction_session_timeout: 15_000,
  };
}

export function createDatabasePool(environment: RuntimeEnvironment, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool(databasePoolConfig(environment, options));
  pool.on('error', () => undefined);
  return pool;
}

export function createDispatcherPool(environment: RuntimeEnvironment, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({ ...databasePoolConfig(environment, options), user: 'document_intelligence_dispatcher', password: environment.POSTGRES_DISPATCHER_PASSWORD });
  pool.on('error', () => undefined);
  return pool;
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  if (result.rowCount !== 1) throw new Error('The vector extension is unavailable');
}

export * from './transactions.js';
export * from './extraction.js';
export * from './financial.js';
export * from './search.js';
export * from './workflow.js';
