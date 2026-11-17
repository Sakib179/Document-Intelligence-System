import { describe, expect, it } from 'vitest';
import { validateFileMetadata, uploadFingerprint } from '../../apps/api/src/ingestion/files.js';
import { ingestionPayloadSchema } from '@doc/contracts';

describe('upload metadata and identity', () => {
  it.each(['../invoice.pdf', 'folder/invoice.pdf', 'C:\\invoice.pdf', 'invoice%2fpdf.pdf', 'invoice\u0000.pdf', 'invoice\u202e.pdf'])('rejects unsafe filename %s', (filename) => {
    expect(() => validateFileMetadata(filename, 'application/pdf')).toThrow();
  });
  it('accepts case-insensitive supported extensions and generic MIME only for later signature validation', () => {
    expect(validateFileMetadata('INVOICE.PDF', 'application/octet-stream').mimeType).toBe('application/pdf');
    expect(validateFileMetadata('data.csv', 'text/plain').mimeType).toBe('text/csv');
  });
  it('rejects extension and declared MIME mismatches', () => {
    expect(() => validateFileMetadata('invoice.exe', 'application/octet-stream')).toThrow();
    expect(() => validateFileMetadata('invoice.png', 'application/pdf')).toThrow();
  });
  it('excludes transient paths from fingerprints and detects changed content', () => {
    const file = { path: '/tmp/one', filename: 'invoice.pdf', extension: '.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) };
    expect(uploadFingerprint([file])).toBe(uploadFingerprint([{ ...file, path: '/tmp/two' }]));
    expect(uploadFingerprint([file])).not.toBe(uploadFingerprint([{ ...file, sha256: 'b'.repeat(64) }]));
  });
  it('rejects large document text or unexpected file data in queue payloads', () => {
    expect(ingestionPayloadSchema.safeParse({ schemaVersion: 1, file: Buffer.from('data'), extractedText: 'text' }).success).toBe(false);
  });
});
