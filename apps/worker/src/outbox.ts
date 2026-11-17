import type pg from 'pg';
import type { Queue } from 'bullmq';
import { ingestionPayloadSchema, extractionJobPayloadSchema,indexingPayloadSchema } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';

type DispatchRow = { job_id: string; tenant_id: string; document_id: string; payload: unknown; dispatch_token: string; max_attempts: number };

export class IngestionOutbox {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly database: pg.Pool,
    private readonly queues: Map<string, Queue>,
    private readonly environment: RuntimeEnvironment,
    private readonly reportError: () => void = () => undefined,
  ) {}

  dispatchOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.publish().finally(() => { this.active = null; });
    return this.active;
  }

  private async publish(): Promise<void> {
    const claims = await this.database.query<DispatchRow>('SELECT * FROM public.claim_ingestion_dispatches($1,$2)', [10, 30]);
    const indexes=await this.database.query<DispatchRow>('SELECT * FROM public.claim_indexing_dispatches($1,$2)',[10,30]);
    await Promise.all([...claims.rows,...indexes.rows].map(async (row) => {
      let published = false;
      const indexing=indexingPayloadSchema.safeParse(row.payload);
      try {
        const extraction = extractionJobPayloadSchema.safeParse(row.payload);
        const payload = indexing.success?indexing.data:extraction.success ? extraction.data : ingestionPayloadSchema.parse(row.payload);
        if (payload.jobId !== row.job_id || payload.tenantId !== row.tenant_id || payload.documentId !== row.document_id) throw new Error('Invalid dispatch references');
        const queue = this.queues.get(indexing.success?'indexing-queue':extraction.success ? 'extraction-queue' : 'document-queue');
        if (!queue) throw new Error('Document queue is unavailable');
        const existing = await queue.getJob(row.job_id);
        if (existing) {
          const state = await existing.getState();
          if (state === 'failed' || state === 'completed') await existing.remove();
        }
        await queue.add(indexing.success?'index':extraction.success ? 'extract' : 'ingest', payload, {
          jobId: row.job_id, attempts: row.max_attempts,
          backoff: { type: 'exponential', delay: this.environment.INGESTION_BACKOFF_MS },
        });
        published = true;
      } catch { this.reportError(); }
      try {
        await this.database.query(indexing.success?'SELECT public.ack_indexing_dispatch($1,$2,$3,$4,$5)':'SELECT public.ack_ingestion_dispatch($1,$2,$3,$4,$5)', [
          row.job_id, row.dispatch_token, published, this.environment.INGESTION_BACKOFF_MS, this.environment.OUTBOX_RECHECK_SECONDS,
        ]);
      } catch { this.reportError(); /* Expired leases are reclaimed after database recovery. */ }
    }));
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { void this.dispatchOnce().catch(this.reportError); };
    tick();
    this.timer = setInterval(tick, this.environment.OUTBOX_POLL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try { await this.active; } catch { /* A durable lease remains recoverable. */ }
  }
}
