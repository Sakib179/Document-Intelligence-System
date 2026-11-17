import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { projectRoot } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { APPLICATION_ROLE, databasePoolConfig } from './index.js';
import type { PoolOptions } from './index.js';
import { withTransaction } from './transactions.js';

export const migrationsDirectory = join(projectRoot(), 'packages/database/migrations');

export function createMigrationPool(environment: RuntimeEnvironment, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    ...databasePoolConfig(environment, options),
    user: environment.POSTGRES_USER,
    password: environment.POSTGRES_PASSWORD,
    statement_timeout: 120_000,
  });
  pool.on('error', () => undefined);
  return pool;
}

export { createDispatcherPool } from './index.js';

/** Cluster-level role setup is separate from database-local schema migrations. */
export async function provisionApplicationRole(pool: pg.Pool, password: string): Promise<void> {
  return provisionRestrictedRole(pool, APPLICATION_ROLE, password);
}

export async function provisionDispatcherRole(pool: pg.Pool, password: string): Promise<void> {
  return provisionRestrictedRole(pool, 'document_intelligence_dispatcher', password);
}

async function provisionRestrictedRole(pool: pg.Pool, roleName: string, password: string): Promise<void> {
  if (password.length < 20 || password.startsWith('REPLACE_')) throw new Error('Configure the application database password');
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(220010, 2)');
    const existing = await client.query<{
      rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean;
      rolcreatedb: boolean; rolreplication: boolean; rolinherit: boolean;
    }>('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit FROM pg_roles WHERE rolname = $1', [roleName]);
    const role = existing.rows[0];
    if (role && Object.values(role).some(Boolean)) throw new Error('Existing runtime role has unsafe privileges; refusing to reuse it');
    const memberships = await client.query('SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)', [roleName]);
    if (memberships.rowCount) throw new Error('Runtime role must not inherit or switch into another role');
    // Role DDL does not accept bind parameters. PostgreSQL format quotes safely.
    // Neither the generated SQL nor the password is logged.
    const statement = await client.query<{ sql: string }>(
      role
        ? "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql"
        : "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
      [roleName, password],
    );
    const sql = statement.rows[0]?.sql;
    if (!sql) throw new Error('Could not prepare application role');
    await client.query(sql);
  });
}

export async function migrationStatus(pool: pg.Pool, directory = migrationsDirectory) {
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const exists = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.pgmigrations') IS NOT NULL AS exists");
  const applied = exists.rows[0]?.exists
    ? (await pool.query<{ name: string; run_on: Date }>('SELECT name, run_on FROM public.pgmigrations ORDER BY id')).rows
    : [];
  const byName = new Map(applied.map((entry) => [entry.name, entry]));
  const result = files.map((file) => {
    const name = file.slice(0, -4);
    return { name, status: byName.has(name) ? 'applied' : 'pending', appliedAt: byName.get(name)?.run_on ?? null };
  });
  for (const entry of applied) {
    if (!files.includes(entry.name + '.sql')) result.push({ name: entry.name, status: 'missing', appliedAt: entry.run_on });
  }
  return result;
}

export async function runMigrations(
  pool: pg.Pool,
  options: { direction?: 'up' | 'down'; count?: number; directory?: string; dryRun?: boolean } = {},
): Promise<{ name: string }[]> {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    return await runner({
      dbClient: client,
      dir: options.directory ?? migrationsDirectory,
      direction: options.direction ?? 'up',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: 'fail',
      dryRun: options.dryRun ?? false,
      ...(options.count === undefined ? {} : { count: options.count }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      verbose: false,
    });
  } finally {
    try { await client.query('RESET lock_timeout'); } finally { client.release(); }
  }
}

export async function seedDevelopmentDatabase(pool: pg.Pool, environment: string): Promise<void> {
  if (environment !== 'development' && environment !== 'test') throw new Error('Development seed is disabled outside development/test');
  const sql = await readFile(join(projectRoot(), 'packages/database/seeds/development.sql'), 'utf8');
  await withTransaction(pool, async (client) => { await client.query(sql); });
}
