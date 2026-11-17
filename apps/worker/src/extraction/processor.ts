import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type pg from 'pg';
import { extractionJobPayloadSchema } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';
import { extractInvoice } from './engine.js';
import { buildExtractionContext } from './context.js';
import { createInvoiceProviders } from './providers.js';
import { ExtractionRepository } from './repository.js';
import { ProviderFailure } from './types.js';
import type { InvoiceProvider } from './types.js';

export type InvoiceProviders = { gemini: InvoiceProvider | null; local: InvoiceProvider | null };
export class InvoiceExtractionProcessor {
  private readonly repository: ExtractionRepository;
  constructor(private readonly database: pg.Pool, private readonly environment: RuntimeEnvironment,
    private readonly providers: InvoiceProviders = createInvoiceProviders(environment), private readonly wait?: (ms: number) => Promise<void>) {
    this.repository = new ExtractionRepository(database, environment);
  }
  async process(job: Job, queueToken?: string) {
    const parsed = extractionJobPayloadSchema.safeParse(job.data);
    if (!parsed.success || job.name !== 'extract' || job.id !== parsed.data.jobId) throw new UnrecoverableError('INVALID_EXTRACTION_JOB');
    const payload = parsed.data;
    const claim = await this.repository.claim(payload, this.providers);
    if ('done' in claim) return { stage: 'invoice_extraction_complete' };
    if ('terminal' in claim) throw new UnrecoverableError('EXTRACTION_JOB_TERMINAL');
    if ('defer' in claim) { await job.moveToDelayed(claim.defer, queueToken); throw new DelayedError(); }
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return; renewing = true;
      void this.repository.heartbeat(payload, claim.token).catch(() => undefined).finally(() => { renewing = false; });
    }, 30_000);
    heartbeat.unref();
    try {
      const context = await buildExtractionContext(this.database, payload.tenantId, claim.candidate, claim.sourceVersion, this.environment.EXTRACTION_MAX_CONTEXT_CHARS);
      await this.repository.attachContext(payload, claim.token, context);
      const outcome = await extractInvoice(context, this.environment, this.providers, {
        policy: () => this.repository.policy(payload),
        before: (provider, attempt, fallback) => this.repository.beginAttempt(payload, claim.token, context, provider, attempt, fallback),
        after: (id, event) => {
          const provider = event.provider === 'gemini' ? this.providers.gemini : this.providers.local;
          if (!provider) throw new Error('Provider completion is unavailable');
          return this.repository.endAttempt(payload, claim.token, provider, id, event);
        },
        ...(this.wait ? { wait: this.wait } : {}),
      });
      const result = await this.repository.complete(payload, claim, outcome);
      if (!result.success) throw new UnrecoverableError(outcome.errorCode ?? 'ALL_PROVIDERS_FAILED');
      return { stage: 'invoice_extraction_complete', invoiceId: result.invoiceId, requiresManualReview: true };
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      const code = error instanceof ProviderFailure ? error.code : 'EXTRACTION_EXECUTION_INTERRUPTED';
      await this.repository.interrupt(payload, claim.token, code);
      throw new Error(code);
    } finally { clearInterval(heartbeat); }
  }
}
