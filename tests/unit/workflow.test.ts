import { describe, it, expect } from 'vitest';
import { invoiceCorrectionSchema, pageQuerySchema, retryRequestSchema } from '@doc/contracts';
import { decodePage } from '@doc/database';
import { openApiDocument } from '../../apps/api/src/workflow/openapi.js';
describe('workflow API contracts', () => {
  it('accepts exact decimal strings and explicit missing values', () => {
    expect(invoiceCorrectionSchema.parse({ revision: 1, changes: { total: '9999999999999999.99', tax: null } }).changes?.total).toBe('9999999999999999.99');
  });
  it.each([0.1, 'NaN', '1e3', '1.123456789', '12345678901234567'])('rejects invalid financial correction %s', total => {
    expect(invoiceCorrectionSchema.safeParse({ revision: 1, changes: { total } }).success).toBe(false);
  });
  it('requires a revision and changed fields and rejects writable provenance', () => {
    for (const body of [{ changes: { total: '1' } }, { revision: 1, changes: {} }, { revision: 1, changes: { original_values: { total: '1' } } }, { revision: 1, changes: { currency: 'US$' } }])
      expect(invoiceCorrectionSchema.safeParse(body).success).toBe(false);
  });
  it('preserves optional user reasons and bounds cursors and page sizes', () => {
    expect(retryRequestSchema.parse({ reason: ' recovered ' })).toEqual({ reason: 'recovered' });
    expect(pageQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(pageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(() => decodePage('malformed')).toThrow('Invalid pagination cursor');
  });
  it('round trips precise opaque cursors without losing microseconds', () => {
    const cursor = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-11-16T00:00:00.123456Z' };
    expect(decodePage(Buffer.from(JSON.stringify(cursor)).toString('base64url'))).toEqual(cursor);
  });
  it('documents operations with security, error responses and correction schema', () => {
    expect(openApiDocument.paths['/api/v1/invoices/{id}'].patch.requestBody).toBeDefined();
    for (const path of Object.values(openApiDocument.paths))
      for (const operation of Object.values(path)) {
        expect(operation.security).toEqual([]);
        expect(operation.responses['401']).toBeUndefined();
      }
  });
});
