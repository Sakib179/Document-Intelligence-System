import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ProviderFailure } from './types.js';

export function isPrivateAddress(input: string): boolean {
  const address = input.toLowerCase();
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31;
  }
  return isIP(address) === 6 && /^(fc|fd)/.test(address);
}

/** Resolve once, verify private addresses, and pin the connection. No redirects. */
export async function localCompletion(base: string, allowedHosts: string[], body: unknown, signal: AbortSignal): Promise<{ status: number; body: string; retryAfter: string | undefined }> {
  const url = new URL(base);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !allowedHosts.includes(host)) throw new ProviderFailure('LOCAL_ENDPOINT_NOT_TRUSTED', false, false);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => !isPrivateAddress(entry.address))) throw new ProviderFailure('LOCAL_ENDPOINT_NOT_PRIVATE', false, false);
  const target = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  url.pathname = (url.pathname.replace(/\/$/, '') || '/v1') + '/chat/completions';
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', signal, family: target.family, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family),
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_097_152) request.destroy(new ProviderFailure('PROVIDER_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8'), retryAfter: response.headers['retry-after'] }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
}
