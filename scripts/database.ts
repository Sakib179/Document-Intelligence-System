import { loadEnvironment } from '@doc/core';
import { createMigrationPool, migrationStatus, provisionApplicationRole, provisionDispatcherRole, runMigrations, seedDevelopmentDatabase } from '@doc/database/admin';

const environment = loadEnvironment();
const pool = createMigrationPool(environment);
const command = process.argv[2];
try {
  if (command === 'setup' || command === 'migrate') {
    await provisionApplicationRole(pool, environment.POSTGRES_APP_PASSWORD);
    await provisionDispatcherRole(pool, environment.POSTGRES_DISPATCHER_PASSWORD);
    const result = await runMigrations(pool);
    console.log('Applied ' + result.length + ' SQL migration(s).');
    if (command === 'setup') {
      await seedDevelopmentDatabase(pool, environment.NODE_ENV);
      console.log('Loaded idempotent fictional development fixtures. No objects were uploaded or documents processed.');
    }
  } else if (command === 'status') {
    console.table(await migrationStatus(pool));
  } else if (command === 'seed') {
    await seedDevelopmentDatabase(pool, environment.NODE_ENV);
    console.log('Loaded idempotent fictional development fixtures.');
  } else if (command === 'rollback') {
    const args = process.argv.slice(3);
    const versionIndex = args.indexOf('--version');
    const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
    if (!version || !/^\d{4}$/.test(version)) throw new Error('Rollback requires --version followed by the current four-digit migration version');
    const applied = (await migrationStatus(pool)).filter((migration) => migration.status === 'applied');
    const latest = applied.at(-1);
    if (!latest || !latest.name.startsWith(version + '_')) throw new Error('Requested version is not the latest applied migration');
    const dryRun = args.includes('--dry-run');
    await runMigrations(pool, { direction: 'down', count: 1, dryRun });
    console.log(dryRun ? 'Rollback dry run completed; no schema changes committed.' : 'Rolled back ' + latest.name + '.');
  } else {
    throw new Error('Expected setup, migrate, status, seed, or rollback');
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  console.error('Database command failed' + (code ? ' (' + code + ')' : '') + '.');
  // PostgreSQL errors can include complete row values, so never print detail/SQL.
  if (error instanceof Error && !code && !('detail' in error)) console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
