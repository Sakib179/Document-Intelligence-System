import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { GeminiInvoiceProvider, LocalQwenInvoiceProvider, statusFailure } from '../../apps/worker/src/extraction/providers.js';
import { localCompletion, isPrivateAddress } from '../../apps/worker/src/extraction/local-transport.js';
import { extractionContext, mockInvoice } from '../fixtures/extraction.js';

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void, action: (base: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
  try { await action('http://127.0.0.1:' + address.port + '/v1'); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
it('uses the official Gemini SDK with bounded structured output and no tools', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) as Record<string, unknown>;
    calls.push({ url: String(input instanceof Request ? input.url : input), body });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(mockInvoice()) }], role: 'model' } }],
      modelVersion: 'gemini-mock-version', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
  };
  const provider = new GeminiInvoiceProvider('gemini-fixture', 'test-only-gemini-key-not-real', 1000, transport);
  const response = await provider.extract(extractionContext(), AbortSignal.timeout(1000));
  expect(response.modelVersion).toBe('gemini-mock-version'); expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toContain('https://generativelanguage.googleapis.com/');
  expect(calls[0]?.body).not.toHaveProperty('tools');
  expect(calls[0]?.body).toHaveProperty('generationConfig.responseJsonSchema');
  expect(calls[0]?.body).toHaveProperty('generationConfig.maxOutputTokens', 32768);
  expect(JSON.stringify(calls[0]?.body)).toContain('Never invent values');
});
it('sends OpenAI-compatible structured requests to a pinned private Qwen endpoint', async () => {
  let body: Record<string, unknown> | null = null;
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model: 'qwen-fixture-instruct', system_fingerprint: 'qwen-mock-version', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(mockInvoice()) } }] }));
    });
  }, async (base) => {
    const provider = new LocalQwenInvoiceProvider('qwen-fixture-instruct', base, ['127.0.0.1']);
    const result = await provider.extract(extractionContext(), AbortSignal.timeout(1000));
    expect(result.modelVersion).toBe('qwen-mock-version'); expect(JSON.parse(result.text)).toHaveProperty('invoice_number.value', 'INV-101');
  });
  expect(body).toHaveProperty('response_format.type', 'json_schema');
  expect(body).toHaveProperty('max_tokens', 16384);
  expect(body).toHaveProperty('stream', false);
  expect(body).not.toHaveProperty('tools');
});
it('rejects external addresses and unapproved hosts before any document request', async () => {
  for (const address of ['8.8.8.8', '169.254.169.254', '2606:4700::1111']) expect(isPrivateAddress(address)).toBe(false);
  for (const address of ['127.0.0.1', '::1', '10.0.0.4', '192.168.1.2', '172.16.0.2', 'fd00::1']) expect(isPrivateAddress(address)).toBe(true);
  await expect(localCompletion('http://8.8.8.8/v1', ['8.8.8.8'], {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'LOCAL_ENDPOINT_NOT_PRIVATE' });
  await expect(localCompletion('https://unapproved.example/v1', ['localhost'], {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'LOCAL_ENDPOINT_NOT_TRUSTED' });
});
it('does not follow a local redirect to an external provider', async () => {
  let calls = 0;
  await withServer((_request, response) => { calls++; response.writeHead(302, { location: 'https://generativelanguage.googleapis.com/' }); response.end(); }, async (base) => {
    await expect(new LocalQwenInvoiceProvider('qwen-fixture', base, ['127.0.0.1']).extract(extractionContext(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
  });
  expect(calls).toBe(1);
});
it('bounds local transport response size', async () => {
  await withServer((_request, response) => response.end('x'.repeat(2_097_153)), async (base) => {
    await expect(localCompletion(base, ['127.0.0.1'], {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });
});
it('rejects remote/cloud model tags even on a private local server', async () => {
  await expect(new LocalQwenInvoiceProvider('qwen-cloud', 'http://127.0.0.1:1/v1', ['127.0.0.1']).extract(extractionContext(), AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'REMOTE_MODEL_NOT_ALLOWED' });
});
it('classifies rate limits, retry-after and authentication errors', () => {
  expect(statusFailure(429, '2')).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true, retryAfterMs: 2000 });
  expect(statusFailure(401)).toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED', retryable: false });
  expect(statusFailure(503)).toMatchObject({ retryable: true });
});
it('bounds fallback for unsupported local structured output and retains the validated output structure', async () => {
  const bodies: Record<string, unknown>[] = [];
  await withServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      response.setHeader('content-type', 'application/json');
      if (body.response_format) { response.writeHead(501); response.end(JSON.stringify({ error: { message: 'structured output is unavailable' } })); }
      else response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(mockInvoice()) } }] }));
    });
  }, async base => {
    const provider = new LocalQwenInvoiceProvider('qwen-fixture', base, ['127.0.0.1']);
    expect(JSON.parse((await provider.extract(extractionContext(), AbortSignal.timeout(1000))).text)).toHaveProperty('invoice_number.value', 'INV-101');
    await provider.extract(extractionContext(), AbortSignal.timeout(1000));
  });
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toHaveProperty('response_format');
  expect(bodies[1]).not.toHaveProperty('response_format');
  expect(bodies[2]).not.toHaveProperty('response_format');
  expect(JSON.stringify(bodies[1]?.messages)).toContain('populated invoice JSON object');
  expect(JSON.stringify(bodies[1]?.messages)).toContain('Do NOT return a JSON Schema');
  expect(bodies[1]).toHaveProperty('reasoning_effort', 'none');
});

it('accepts a single local JSON fence without evaluating code or surrounding prose', async () => {
  await withServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(mockInvoice()) + '\n```' } }] }));
  }, async base => {
    const result = await new LocalQwenInvoiceProvider('qwen-fixture', base, ['127.0.0.1']).extract(extractionContext(), AbortSignal.timeout(1000));
    expect(JSON.parse(result.text)).toHaveProperty('invoice_number.value', 'INV-101');
  });
});
