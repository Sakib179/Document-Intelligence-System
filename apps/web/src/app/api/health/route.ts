import { healthResponseSchema } from '@doc/contracts';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(healthResponseSchema.parse({
    service: 'web', status: 'ok', timestamp: new Date().toISOString(),
  }), { headers: { 'Cache-Control': 'no-store' } });
}
