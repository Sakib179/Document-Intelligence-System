import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ServiceError, type RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction } from '@doc/database';

export type Principal = {
  tenantId: string;
  userId: string;
  role: 'admin' | 'reviewer' | 'reader';
};

declare module 'fastify' {
  interface FastifyRequest { principal: Principal | null }
}

/** Every local visitor acts as the server-configured workspace operator. */
export async function registerWorkspaceContext(
  app: FastifyInstance,
  pool: pg.Pool,
  environment: RuntimeEnvironment,
) {
  app.decorateRequest('principal', null);
  return async function resolveWorkspace(request: FastifyRequest) {
    const tenantId = environment.LOCAL_WORKSPACE_TENANT_ID;
    const userId = environment.LOCAL_WORKSPACE_USER_ID;
    try {
      const role = await withTenantTransaction(pool, { tenantId, actorUserId: userId }, async client => {
        const user = (await client.query<{ role: Principal['role'] }>(
          'SELECT role FROM public.users WHERE id=$1 AND is_active', [userId],
        )).rows[0];
        if (!user) throw new Error('Workspace operator is unavailable');
        return user.role;
      });
      request.principal = { tenantId, userId, role };
    } catch {
      throw new ServiceError('WORKSPACE_UNAVAILABLE', 503, 'The configured workspace or operator is unavailable.');
    }
  };
}
