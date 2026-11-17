import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClamAvScanner, DisabledAntivirusScanner } from '@doc/core';

async function withDaemon(answer: string, operation: (port: number, path: string, received: () => Buffer) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'clamav-protocol-'));
  const path = join(directory, 'fixture');
  await writeFile(path, 'A harmless protocol fixture');
  let received = Buffer.alloc(0);
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let header = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!header && buffer.length >= 10) {
        expect(buffer.subarray(0, 10).toString()).toBe('zINSTREAM\0');
        buffer = buffer.subarray(10); header = true;
      }
      while (header && buffer.length >= 4) {
        const size = buffer.readUInt32BE();
        if (buffer.length < 4 + size) break;
        if (!size) { socket.end(answer + '\0'); return; }
        received = Buffer.concat([received, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try { await operation(address.port, path, () => received); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}

it('streams framed bytes to ClamAV and records a clean result', async () => {
  await withDaemon('stream: OK', async (port, path, received) => {
    const result = await new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 1000 }).scan(path);
    expect(result.status).toBe('clean');
    expect(result.engine).toBe('clamav');
    expect(received().toString()).toBe('A harmless protocol fixture');
  });
});
it('rejects a malware result without disclosing scanner internals', async () => {
  await withDaemon('stream: test-signature FOUND', async (port, path) => {
    await expect(new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 1000 }).scan(path)).rejects.toMatchObject({ code: 'MALWARE_DETECTED', statusCode: 422 });
  });
});
it('fails closed on scanner protocol errors', async () => {
  await withDaemon('stream: size limit exceeded. ERROR', async (port, path) => {
    await expect(new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 1000 }).scan(path)).rejects.toMatchObject({ code: 'ANTIVIRUS_UNAVAILABLE', statusCode: 503 });
  });
});
it('does not label disabled scanning as clean', async () => {
  expect(await new DisabledAntivirusScanner().scan()).toEqual({ status: 'not_scanned', engine: null, scannedAt: null });
});
