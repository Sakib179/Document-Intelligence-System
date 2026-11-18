import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { invoiceExtractionSchema } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';
import { groundInvoice } from './grounding.js';
import { ProviderFailure, permitsCloud } from './types.js';
import type { AttemptEvent, CloudPolicy, ExtractionContext, ExtractionOutcome, InvoiceProvider, ProviderOutput } from './types.js';
import { safeProviderFailure } from './providers.js';

export type ExtractionHooks = {
  policy: () => Promise<CloudPolicy>;
  before: (provider: InvoiceProvider, attempt: number, fallback: boolean) => Promise<string>;
  after: (id: string, event: AttemptEvent) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
};

const DECIMAL_HEADER_FIELDS = ['subtotal', 'tax', 'total'] as const;
const DECIMAL_LINE_FIELDS = ['quantity', 'unit_price', 'tax_rate', 'line_total'] as const;
const UNAMBIGUOUS_GROUPED_DECIMAL = /^-?\d{1,3}(?:,\d{3})+\.\d{1,8}$/;

/** Normalize unambiguous thousands-grouped decimal strings (e.g. "344,100.00" -> "344100.00")
 *  in model value slots before strict Zod schema checks. Never touches raw_value, numbers, or ambiguous commas. */
function normalizeGroupedDecimalValues(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = structuredClone(input) as Record<string, unknown>;
  const cleanField = (field: unknown) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return;
    const obj = field as Record<string, unknown>;
    if (typeof obj.value === 'string' && UNAMBIGUOUS_GROUPED_DECIMAL.test(obj.value.trim())) {
      obj.value = obj.value.trim().replaceAll(',', '');
    }
  };
  for (const key of DECIMAL_HEADER_FIELDS) cleanField(record[key]);
  if (Array.isArray(record.line_items)) {
    for (const line of record.line_items) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) continue;
      for (const key of DECIMAL_LINE_FIELDS) cleanField((line as Record<string, unknown>)[key]);
    }
  }
  return record;
}

export async function extractInvoice(context: ExtractionContext, environment: RuntimeEnvironment,
  providers: { gemini: InvoiceProvider | null; local: InvoiceProvider | null }, hooks: ExtractionHooks): Promise<ExtractionOutcome> {
  const start = performance.now(), attempts: AttemptEvent[] = [];
  let lastError = environment.CLOUD_LLM_ENABLED ? 'NO_ALLOWED_PROVIDER' : 'CLOUD_DISABLED', lastProvider: InvoiceProvider | null = null, fallbackUsed = false;
  const choices = [providers.gemini, providers.local].filter((provider): provider is InvoiceProvider => provider !== null);
  for (const provider of choices) {
    if (provider.name === 'gemini' && !permitsCloud(environment.CLOUD_LLM_ENABLED, await hooks.policy())) { lastError = 'CLOUD_PROCESSING_NOT_PERMITTED'; continue; }
    fallbackUsed = provider.name === 'local_qwen' && lastProvider?.name === 'gemini'; lastProvider = provider;
    for (let number = 1; number <= environment.LLM_MAX_ATTEMPTS; number++) {
      // Policies are rechecked before every network request, including primary retries.
      if (provider.name === 'gemini' && !permitsCloud(environment.CLOUD_LLM_ENABLED, await hooks.policy())) { lastError = 'CLOUD_PROCESSING_NOT_PERMITTED'; break; }
      let attemptId: string;
      try { attemptId = await hooks.before(provider, number, fallbackUsed); }
      catch (error) {
        if (error instanceof ProviderFailure) { lastError = error.code; break; }
        throw error; // No call if durable logging/lease fencing is unavailable.
      }
      const attemptedAt = performance.now(), signal = AbortSignal.timeout(environment.LLM_TIMEOUT_MS);
      let schemaValid: boolean | null = null;
      let modelVersion: string | null = null, usage: ProviderOutput['usage'] = {};
      let logging = false;
      try {
        const output = await new Promise<Awaited<ReturnType<InvoiceProvider['extract']>>>((resolve, reject) => {
          const aborted = () => reject(new ProviderFailure('PROVIDER_TIMEOUT', true));
          signal.addEventListener('abort', aborted, { once: true });
          void provider.extract(context, signal).then(resolve, (error: unknown) => reject(safeProviderFailure(error, signal)))
            .finally(() => signal.removeEventListener('abort', aborted));
        });
        modelVersion = output.modelVersion; usage = output.usage;
        if (Buffer.byteLength(output.text) > 2_097_152) throw new ProviderFailure('PROVIDER_RESPONSE_TOO_LARGE');
        let json: unknown;
        try { json = JSON.parse(output.text); } catch { schemaValid = false; throw new ProviderFailure('PROVIDER_INVALID_JSON'); }
        const parsed = invoiceExtractionSchema.safeParse(normalizeGroupedDecimalValues(json));
        schemaValid = parsed.success;
        if (!parsed.success) throw new ProviderFailure('PROVIDER_SCHEMA_INVALID');
        const result = groundInvoice(parsed.data, context);
        const event: AttemptEvent = { provider: provider.name, model: provider.model, attempt: number, fallbackUsed, status: 'succeeded', schemaValid,
          durationMs: Math.round(performance.now() - attemptedAt), errorCode: null, modelVersion: output.modelVersion, usage: output.usage };
        logging = true; await hooks.after(attemptId, event); logging = false; attempts.push(event);
        return { provider: provider.name, model: provider.model, modelVersion: output.modelVersion, proposed: parsed.data, grounded: result.grounded,
          issues: result.issues, fallbackUsed, fallbackReason: fallbackUsed ? lastError : null, attempts, errorCode: null, durationMs: Math.round(performance.now() - start) };
      } catch (error) {
        // A logging error must not be misrepresented as a provider failure or trigger another paid call.
        if (logging || !(error instanceof ProviderFailure)) throw error;
        const failure = safeProviderFailure(error, signal);
        const event: AttemptEvent = { provider: provider.name, model: provider.model, attempt: number, fallbackUsed, status: 'failed', schemaValid,
          durationMs: Math.round(performance.now() - attemptedAt), errorCode: failure.code, modelVersion, usage };
        await hooks.after(attemptId, event); attempts.push(event); lastError = failure.code;
        if (failure.retryable && number < environment.LLM_MAX_ATTEMPTS && failure.retryAfterMs <= environment.LLM_RETRY_MAX_MS) {
          const delay = Math.min(environment.LLM_RETRY_MAX_MS, Math.max(failure.retryAfterMs, environment.LLM_RETRY_BASE_MS * 2 ** (number - 1)));
          await (hooks.wait ?? sleep)(delay); continue;
        }
        if (!failure.fallbackAllowed) return { provider: provider.name, model: provider.model, modelVersion: null, proposed: null, grounded: null,
          issues: [], fallbackUsed, fallbackReason: fallbackUsed ? lastError : null, attempts, errorCode: failure.code, durationMs: Math.round(performance.now() - start) };
        break;
      }
    }
  }
  return { provider: lastProvider?.name ?? null, model: lastProvider?.model ?? null, modelVersion: null,
    proposed: null, grounded: null, issues: [], fallbackUsed, fallbackReason: fallbackUsed ? lastError : null, attempts, errorCode: lastError, durationMs: Math.round(performance.now() - start) };
}
