import type pg from 'pg';
import { z } from 'zod';

const tenantContextSchema = z.object({
  tenantId: z.uuid(),
  actorUserId: z.uuid().nullable().optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export type TenantContext = z.infer<typeof tenantContextSchema>;
type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export async function withTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
  options: { isolationLevel?: IsolationLevel } = {},
): Promise<T> {
  const level = z.enum(['read committed', 'repeatable read', 'serializable']).parse(options.isolationLevel ?? 'read committed');
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL ' + level);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Use inside a transaction. Tenant/operator identity must come from trusted server configuration or workers. */
export async function setTenantContext(client: pg.PoolClient, input: TenantContext): Promise<void> {
  const context = tenantContextSchema.parse(input);
  await client.query('SET LOCAL ROLE document_intelligence_app');
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.change_reason', $3, true)",
    [context.tenantId, context.actorUserId ?? '', context.reason ?? ''],
  );
  const tenant = await client.query('SELECT id FROM public.tenants WHERE id = $1 AND status = $2', [context.tenantId, 'active']);
  if (tenant.rowCount !== 1) throw new Error('An active tenant is required');
  if (context.actorUserId) {
    const actor = await client.query('SELECT id FROM public.users WHERE id = $1 AND tenant_id = $2 AND is_active', [context.actorUserId, context.tenantId]);
    if (actor.rowCount !== 1) throw new Error('The actor must belong to the active tenant');
  }
}

export async function withTenantTransaction<T>(
  pool: pg.Pool,
  context: TenantContext,
  operation: (client: pg.PoolClient) => Promise<T>,
  options: { isolationLevel?: IsolationLevel } = {},
): Promise<T> {
  tenantContextSchema.parse(context);
  return withTransaction(pool, async (client) => {
    await setTenantContext(client, context);
    return operation(client);
  }, options);
}
