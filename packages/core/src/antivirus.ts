import { createConnection } from 'node:net';
import { createReadStream } from 'node:fs';
import type { AntivirusResult } from '@doc/contracts';
import type { RuntimeEnvironment } from './env.js';
import { ServiceError } from './errors.js';

export interface AntivirusScanner { scan(path: string): Promise<AntivirusResult> }

export class DisabledAntivirusScanner implements AntivirusScanner {
  async scan(): Promise<AntivirusResult> { return { status: 'not_scanned', engine: null, scannedAt: null }; }
}

/** ClamD INSTREAM protocol; no shell commands or uploaded filenames are executed. */
export class ClamAvScanner implements AntivirusScanner {
  constructor(private readonly options: { host: string; port: number; timeoutMs: number }) {}

  async scan(path: string): Promise<AntivirusResult> {
    const socket = createConnection({ host: this.options.host, port: this.options.port });
    const source = createReadStream(path, { highWaterMark: 65_536 });
    const unavailable = () => new ServiceError('ANTIVIRUS_UNAVAILABLE', 503, 'The configured antivirus scanner is unavailable.');
    let finish!: (value: AntivirusResult) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<AntivirusResult>((resolve, reject) => { finish = resolve; fail = reject; });
    const deadline = setTimeout(() => { fail(unavailable()); socket.destroy(); }, this.options.timeoutMs);
    let response = '';
    socket.on('error', () => fail(unavailable()));
    socket.setTimeout(this.options.timeoutMs, () => { fail(unavailable()); socket.destroy(); });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (response.length > 1024) { fail(unavailable()); socket.destroy(); return; }
      if (!response.includes('\0') && !response.includes('\n')) return;
      const line = response.split(/[\0\n]/)[0]?.trim() ?? '';
      if (line.endsWith(' FOUND')) fail(new ServiceError('MALWARE_DETECTED', 422, 'The upload was rejected by antivirus scanning.'));
      else if (line === 'stream: OK') finish({ status: 'clean', engine: 'clamav', scannedAt: new Date().toISOString() });
      else fail(unavailable());
    });
    socket.on('end', () => { if (!response.includes('\0') && !response.includes('\n')) fail(unavailable()); });
    const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => {
      socket.write(chunk, (error?: Error | null) => error ? reject(unavailable()) : resolve());
    });
    const send = async () => {
      await write(Buffer.from('zINSTREAM\0'));
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(buffer.length);
        await write(header);
        await write(buffer);
      }
      await write(Buffer.alloc(4));
    };
    try {
      const [, scanned] = await Promise.all([send(), result]);
      return scanned;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw unavailable();
    } finally { clearTimeout(deadline); source.destroy(); socket.destroy(); }
  }
}

export function createAntivirusScanner(environment: RuntimeEnvironment): AntivirusScanner {
  return environment.ANTIVIRUS_MODE === 'clamav'
    ? new ClamAvScanner({ host: environment.CLAMAV_HOST, port: environment.CLAMAV_PORT, timeoutMs: environment.CLAMAV_TIMEOUT_MS })
    : new DisabledAntivirusScanner();
}
