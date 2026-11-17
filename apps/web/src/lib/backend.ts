import { loadEnvironment } from '@doc/core';
import { workspaceUserSchema } from '@doc/contracts';
export async function backend(path: string, init: RequestInit & {
  duplex?: 'half';
} = {}) {
  const env = loadEnvironment(), host = env.API_HOST === '0.0.0.0' ? '127.0.0.1' : env.API_HOST;
  return fetch('http://' + host + ':' + env.API_PORT + '/api/v1/' + path, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(150000)]) });
}
export type WorkspaceUser = import('./types').User;
export async function workspaceUser(): Promise<WorkspaceUser> {
  let response: Response;
  try {
    response = await backend('me', { signal: AbortSignal.timeout(5000) });
  }
  catch {
    throw new Error('The workspace API is unavailable. Please try again.');
  }
  if (!response.ok)
    throw new Error('The workspace API is unavailable. Please try again.');
  return workspaceUserSchema.parse(await response.json());
}
