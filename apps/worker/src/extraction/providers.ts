import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { invoiceExtractionSchema, invoiceLineExtractionSchema } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';
import { EXTRACTION_SYSTEM_PROMPT } from './prompt.js';
import { ProviderFailure } from './types.js';
import type { ExtractionContext, InvoiceProvider, ProviderOutput } from './types.js';
import { localCompletion } from './local-transport.js';

export const invoiceResponseJsonSchema = z.toJSONSchema(invoiceExtractionSchema);
const STRIPPED_SERVING_KEYS = new Set(['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'minimum', 'maximum', 'additionalProperties']);
/** Strip regex/length/item-count FSM bounds that trigger Gemini 400 "too many states for serving".
 *  Full strict Zod + grounding checks still run in extractInvoice() on every response. */
function toGeminiServingSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiServingSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_SERVING_KEYS.has(key)) continue;
    out[key] = toGeminiServingSchema(value);
  }
  return out;
}
export const geminiResponseJsonSchema = toGeminiServingSchema(invoiceResponseJsonSchema) as Record<string, unknown>;
const missingField = { value: null, raw_value: null, evidence: null };
const localOutputTemplate = Object.fromEntries(Object.keys(invoiceExtractionSchema.shape).map(key => [key, key === 'line_items' ? [] : missingField]));
const localLineTemplate = Object.fromEntries(Object.keys(invoiceLineExtractionSchema.shape).map(key => [key, missingField]));
const localOutputInstructions = '\nExtract facts from the supplied sources into a populated invoice JSON object. Do NOT return a JSON Schema or copy schema definitions. No markdown or commentary. Fill this output template with supported values; use null only when missing or uncertain: '
  + JSON.stringify(localOutputTemplate) + '\nEach line_items entry must use this field structure: ' + JSON.stringify(localLineTemplate)
  + '\nEvery present field must have value, raw_value and evidence. Evidence must contain source_id, page, text, worksheet and cell; use null for inapplicable worksheet/cell. Use verbatim source quotes and exact source IDs. All amounts and quantities are decimal strings. Return only the populated invoice object.';
export function statusFailure(status: number, retryAfter?: string): ProviderFailure {
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
  const delay = Number.isFinite(seconds) ? Math.min(300_000, seconds) : 0;
  if (status === 429) return new ProviderFailure('PROVIDER_RATE_LIMITED', true, true, delay);
  if (status >= 500 || status === 408) return new ProviderFailure('PROVIDER_UNAVAILABLE', true);
  if (status === 401 || status === 403) return new ProviderFailure('PROVIDER_AUTHENTICATION_FAILED');
  if (status === 404) return new ProviderFailure('PROVIDER_MODEL_NOT_FOUND');
  return new ProviderFailure('PROVIDER_REQUEST_REJECTED');
}
export function safeProviderFailure(error: unknown, signal?: AbortSignal): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (signal?.aborted || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return new ProviderFailure('PROVIDER_TIMEOUT', true);
  if (error && typeof error === 'object') {
    const status = 'status' in error ? Number(error.status) : 'statusCode' in error ? Number(error.statusCode) : null;
    if (status && status >= 400) return statusFailure(status);
  }
  return new ProviderFailure('PROVIDER_CONNECTION_FAILED', true);
}

export class GeminiInvoiceProvider implements InvoiceProvider {
  readonly name = 'gemini' as const;
  readonly endpointFingerprint = createHash('sha256').update('https://generativelanguage.googleapis.com').digest('hex');
  private readonly sdk: GoogleGenAI;
  constructor(readonly model: string, key: string, timeoutMs: number, transport?: typeof fetch) {
    this.sdk = new GoogleGenAI({ apiKey: key, vertexai: false, httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com', timeout: timeoutMs,
      retryOptions: { attempts: 1 }, ...(transport ? { fetch: transport } : {}) } });
  }
  async extract(context: ExtractionContext, signal: AbortSignal): Promise<ProviderOutput> {
    const response = await this.sdk.models.generateContent({ model: this.model, contents: JSON.stringify({ candidate_id: context.candidate_id, sources: context.sources }), config: {
      systemInstruction: EXTRACTION_SYSTEM_PROMPT, responseMimeType: 'application/json', responseJsonSchema: geminiResponseJsonSchema,
      temperature: 0, maxOutputTokens: 32768, abortSignal: signal,
    } });
    const reason = response.candidates?.[0]?.finishReason;
    if (reason && reason !== 'STOP') throw new ProviderFailure(reason === 'MAX_TOKENS' ? 'PROVIDER_OUTPUT_TRUNCATED' : 'PROVIDER_REFUSAL', false, reason === 'MAX_TOKENS');
    const text = response.text;
    if (!text || Buffer.byteLength(text) > 2_097_152) throw new ProviderFailure('PROVIDER_INVALID_RESPONSE');
    return { text, modelVersion: response.modelVersion ?? null, usage: {
      ...(response.usageMetadata?.promptTokenCount !== undefined ? { input_tokens: response.usageMetadata.promptTokenCount } : {}),
      ...(response.usageMetadata?.candidatesTokenCount !== undefined ? { output_tokens: response.usageMetadata.candidatesTokenCount } : {}),
    } };
  }
}

const completionSchema = z.object({ model: z.string().optional(), system_fingerprint: z.string().nullable().optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional() }).optional(),
});
export class LocalQwenInvoiceProvider implements InvoiceProvider {
  readonly name = 'local_qwen' as const;
  private structuredOutputAvailable = true;
  readonly endpointFingerprint: string;
  constructor(readonly model: string, private readonly base: string, private readonly allowed: string[], private readonly version = '') {
    this.endpointFingerprint = createHash('sha256').update(base).digest('hex');
  }
  async extract(context: ExtractionContext, signal: AbortSignal): Promise<ProviderOutput> {
    if (/cloud/i.test(this.model)) throw new ProviderFailure('REMOTE_MODEL_NOT_ALLOWED', false, false);
    const body = () => ({
      model: this.model, stream: false, temperature: 0, max_tokens: 16384, reasoning_effort: 'none',
      messages: [{ role: 'system', content: EXTRACTION_SYSTEM_PROMPT + (this.structuredOutputAvailable ? '' : localOutputInstructions) },
        { role: 'user', content: JSON.stringify({ candidate_id: context.candidate_id, sources: context.sources }) }],
      ...(this.structuredOutputAvailable ? { response_format: { type: 'json_schema', json_schema: { name: 'invoice_extraction', strict: true, schema: invoiceResponseJsonSchema } } } : {}),
    });
    let response = await localCompletion(this.base, this.allowed, body(), signal);
    // Some Ollama runtimes cannot constrain this model's output. Retry once with
    // a concrete output template; engine-side Zod/evidence validation is unchanged.
    if (response.status === 501 && /structured output is unavailable/i.test(response.body)) {
      this.structuredOutputAvailable = false;
      response = await localCompletion(this.base, this.allowed, body(), signal);
    }
    if (response.status !== 200) throw statusFailure(response.status, response.retryAfter);
    let parsed: z.infer<typeof completionSchema>;
    try { parsed = completionSchema.parse(JSON.parse(response.body)); }
    catch { throw new ProviderFailure('PROVIDER_INVALID_RESPONSE'); }
    const choice = parsed.choices[0]!;
    if (choice.message.refusal) throw new ProviderFailure('PROVIDER_REFUSAL', false, false);
    if (choice.finish_reason !== 'stop' || !choice.message.content) throw new ProviderFailure('PROVIDER_OUTPUT_TRUNCATED');
    // Accept a single JSON code fence from unconstrained local runtimes; never
    // extract JSON from prose or execute anything. The engine still validates it.
    const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(choice.message.content);
    return { text: fenced?.[1] ?? choice.message.content, modelVersion: parsed.system_fingerprint ?? (this.version || null), usage: {
      ...(parsed.usage?.prompt_tokens !== undefined ? { input_tokens: parsed.usage.prompt_tokens } : {}),
      ...(parsed.usage?.completion_tokens !== undefined ? { output_tokens: parsed.usage.completion_tokens } : {}),
    } };
  }
}

export function createInvoiceProviders(environment: RuntimeEnvironment): { gemini: InvoiceProvider | null; local: InvoiceProvider | null } {
  return {
    gemini: environment.CLOUD_LLM_ENABLED ? new GeminiInvoiceProvider(environment.GEMINI_MODEL, environment.GEMINI_API_KEY, environment.LLM_TIMEOUT_MS) : null,
    local: environment.LOCAL_LLM_BASE_URL && environment.LOCAL_LLM_MODEL ? new LocalQwenInvoiceProvider(environment.LOCAL_LLM_MODEL, environment.LOCAL_LLM_BASE_URL,
      environment.LOCAL_LLM_ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()), environment.LOCAL_LLM_MODEL_VERSION) : null,
  };
}
