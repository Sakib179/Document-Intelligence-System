import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { inspectionSchema } from '@doc/contracts';
import type { Inspection } from '@doc/contracts';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';

export const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv',
};
export type StagedFile = { path: string; filename: string; extension: string; mimeType: string; sizeBytes: number; sha256: string };
export type ValidatedFile = StagedFile & { inspection: Inspection; antivirus: import('@doc/contracts').AntivirusResult };

export function validateFileMetadata(input: string, declaredMime: string) {
  const filename = input.normalize('NFC');
  if (!filename || Buffer.byteLength(filename) > 255 || filename === '.' || filename === '..' || /[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(filename) || /%2f|%5c/i.test(filename)) {
    throw new ServiceError('UNSAFE_FILENAME', 400, 'Filenames must not contain paths or control characters.');
  }
  const extension = extname(filename).toLowerCase();
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) throw new ServiceError('UNSUPPORTED_EXTENSION', 415, 'This file extension is not supported.');
  const declared = declaredMime.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== mimeType && !(extension === '.csv' && ['text/plain', 'application/csv'].includes(declared))) {
    throw new ServiceError('MIME_MISMATCH', 415, 'The declared MIME type does not match the file extension.');
  }
  return { filename, extension, mimeType };
}

export async function stageMultipart(request: FastifyRequest, environment: RuntimeEnvironment) {
  if (!request.isMultipart()) throw new ServiceError('MULTIPART_REQUIRED', 415, 'Use multipart/form-data with repeated files fields.');
  const directory = await mkdtemp(join(tmpdir(), 'document-upload-'));
  const files: StagedFile[] = [];
  let totalBytes = 0;
  let invalid: Error | undefined;
  const parts = request.parts();
  // The multipart plugin consumes request.raw, so do not start a second pipe in
  // preParsing. Start its parser before attaching a nonbuffering raw-byte guard.
  let pending = parts.next();
  let rawBytes = 0;
  let rawLimitReached = false;
  const rawLimit = environment.UPLOAD_MAX_BATCH_BYTES + environment.UPLOAD_MAX_FILES * 16_384;
  const guard = (chunk: Buffer) => {
    rawBytes += chunk.length;
    if (rawBytes > rawLimit && !rawLimitReached) {
      rawLimitReached = true;
      // Forward the upstream limit failure through multipart's request error
      // handler, which rejects pending parts and destroys its active file stream.
      request.raw.emit('error', new ServiceError('UPLOAD_TOO_LARGE', 413, 'The multipart request exceeds its configured limit.'));
    }
  };
  request.raw.on('data', guard);
  try {
    while (true) {
      const next = await pending;
      if (next.done) break;
      const part = next.value;
      if (part.type !== 'file') throw new ServiceError('UNEXPECTED_FIELD', 400, 'Only files fields are accepted.');
      const path = join(directory, randomUUID());
      const hash = createHash('sha256');
      let sizeBytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        totalBytes += chunk.length;
        if (sizeBytes > environment.UPLOAD_MAX_FILE_BYTES || totalBytes > environment.UPLOAD_MAX_BATCH_BYTES) {
          callback(new ServiceError('UPLOAD_TOO_LARGE', 413, 'The upload exceeds its configured byte limit.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      } });
      await pipeline(part.file, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated) throw new ServiceError('FILE_TOO_LARGE', 413, 'A file exceeds its configured byte limit.');
      try {
        if (part.fieldname !== 'files') throw new ServiceError('UNEXPECTED_FIELD', 400, 'Use repeated files fields.');
        if (!sizeBytes) throw new ServiceError('EMPTY_FILE', 422, 'Empty files are not accepted.');
        const metadata = validateFileMetadata(part.filename, part.mimetype);
        files.push({ ...metadata, path, sizeBytes, sha256: hash.digest('hex') });
      } catch (error) { invalid ??= error instanceof Error ? error : new Error('Invalid upload'); }
      pending = parts.next();
    }
    if (invalid) throw invalid;
    if (!files.length) throw new ServiceError('FILES_REQUIRED', 400, 'At least one file is required.');
    return { files, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    request.raw.unpipe();
    request.raw.resume();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { request.raw.off('data', guard); }
}

export function uploadFingerprint(files: StagedFile[]): string {
  return createHash('sha256').update(JSON.stringify(files.map(({ filename, mimeType, sizeBytes, sha256 }) => ({ filename, mimeType, sizeBytes, sha256 })))).digest('hex');
}

export async function inspectStagedFile(file: StagedFile, environment: RuntimeEnvironment): Promise<Inspection> {
  const body = new FormData();
  body.set('file', await openAsBlob(file.path, { type: file.mimeType }), file.filename);
  let response: Response;
  try {
    response = await fetch('http://' + environment.PROCESSOR_HOST + ':' + environment.PROCESSOR_PORT + '/internal/inspect', {
      method: 'POST', headers: { authorization: 'Bearer ' + environment.PROCESSOR_INTERNAL_TOKEN }, body,
      signal: AbortSignal.timeout(environment.INSPECTION_TIMEOUT_MS + 5_000),
    });
  } catch { throw new ServiceError('INSPECTOR_UNAVAILABLE', 503, 'The local file inspector is unavailable.'); }
  let payload: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty inspector response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4_194_304) { await reader.cancel(); throw new Error('Oversized inspector response'); }
      chunks.push(part.value);
    }
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new ServiceError('INSPECTOR_UNAVAILABLE', 503, 'The local file inspector returned an invalid response.'); }
  if (!response.ok) {
    const code = (payload as { error?: { code?: unknown } })?.error?.code;
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code) && [413, 415, 422].includes(response.status)) {
      throw new ServiceError(code, response.status, 'The file did not pass format or page-limit validation.');
    }
    throw new ServiceError('INSPECTOR_UNAVAILABLE', 503, 'The local file inspector is unavailable.');
  }
  const parsed = inspectionSchema.safeParse(payload);
  if (!parsed.success) throw new ServiceError('INSPECTOR_UNAVAILABLE', 503, 'The local file inspector returned an invalid response.');
  const result = parsed.data;
  if (result.mimeType !== file.mimeType) throw new ServiceError('SIGNATURE_MISMATCH', 415, 'The actual file type does not match its extension.');
  if (result.pageCount > environment.UPLOAD_MAX_PAGES) throw new ServiceError('PAGE_LIMIT_EXCEEDED', 413, 'The document exceeds the configured page limit.');
  return result;
}
