import { backend } from '../../../../lib/backend';
import { allowedProxyPath, sameOrigin } from '../../../../lib/security';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function proxy(request: Request, context: {
  params: Promise<{
    path: string[];
  }>;
}) {
  const path = (await context.params).path.join('/');
  if (!allowedProxyPath(path, request.method))
    return Response.json({ error: { message: 'Unsupported workspace request.' } }, { status: 404 });
  if (request.method !== 'GET' && !sameOrigin(request))
    return Response.json({ error: { message: 'Same-origin request required.' } }, { status: 403 });
  try {
    const headers = new Headers();
    for (const name of ['content-type', 'idempotency-key', 'range']) {
      const value = request.headers.get(name);
      if (value)
        headers.set(name, value);
    }
    const response = await backend(path + new URL(request.url).search, { method: request.method, headers, ...(request.method === 'POST' || request.method === 'PATCH' ? { body: request.body, duplex: 'half' as const } : {}), signal: request.signal });
    const output = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'content-length', 'content-range', 'content-disposition', 'accept-ranges', 'retry-after', 'content-security-policy']) {
      const value = response.headers.get(name);
      if (value)
        output.set(name, value);
    }
    const location = response.headers.get('location');
    if (location?.startsWith('/api/v1/'))
      output.set('Location', location.replace('/api/v1/', '/api/backend/'));
    return new Response(response.body, { status: response.status, headers: output });
  }
  catch {
    return Response.json({ error: { message: 'The document service is unavailable. Please try again.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
