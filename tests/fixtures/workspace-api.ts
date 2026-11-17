import { buildApi as productionApi } from '../../apps/api/src/app.js';
import type { RuntimeEnvironment } from '@doc/core';

/** A test-driver label, not a credential. Never interpreted by production code. */
export function selectWorkspace(_environment: RuntimeEnvironment, context: { tenantId: string; userId: string }) {
  return context.tenantId + ':' + context.userId;
}

/** Test tenant/operator policies using separate server configurations and pools. */
export function buildApi(environment: RuntimeEnvironment, options: Parameters<typeof productionApi>[1] = {}) {
  const app = productionApi(environment, options);
  const inject = app.inject.bind(app);
  const peers = new Map<string, ReturnType<typeof productionApi>>();
  app.inject = (function (input: unknown, ...rest: unknown[]) {
    if (input && typeof input === 'object') {
      const request = input as { headers?: Record<string, string> };
      const selection = request.headers?.['x-test-workspace'];
      if (selection) {
        const match = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/i.exec(selection);
        if (!match) throw new Error('Invalid test workspace selection');
        const headers = { ...request.headers };
        delete headers['x-test-workspace'];
        if (match[1] !== environment.LOCAL_WORKSPACE_TENANT_ID || match[2] !== environment.LOCAL_WORKSPACE_USER_ID) {
          let peer = peers.get(selection);
          if (!peer) {
            peer = productionApi({
              ...environment,
              LOCAL_WORKSPACE_TENANT_ID: match[1]!,
              LOCAL_WORKSPACE_USER_ID: match[2]!,
            }, options);
            peers.set(selection, peer);
          }
          return Reflect.apply(peer.inject, peer, [{ ...request, headers }, ...rest]);
        }
        return Reflect.apply(inject, app, [{ ...request, headers }, ...rest]);
      }
    }
    return Reflect.apply(inject, app, [input, ...rest]);
  }) as typeof app.inject;
  app.addHook('onClose', async () => {
    await Promise.all([...peers.values()].map(peer => peer.close()));
  });
  return app;
}
