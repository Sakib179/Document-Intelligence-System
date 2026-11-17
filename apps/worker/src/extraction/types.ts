import type { InvoiceExtraction } from '@doc/contracts';

export type ProviderName = 'gemini' | 'local_qwen';
export type EvidenceSource = { id: string; page: number; worksheet: string | null; cell: string | null; text: string; context: string;
  role: 'document_field' | 'line_item' | 'table_cell' | 'untyped' };
export type ExtractionContext = { candidate_id: string; sources: EvidenceSource[]; warnings: string[]; digest: string };
export type CloudPolicy = { classification: 'confidential' | 'public' | 'synthetic'; classifiedBy: string | null; classifiedAt: string | null;
  allowed: boolean; approvedBy: string | null; approvedAt: string | null };
export const permitsCloud = (enabled: boolean, policy: CloudPolicy) => enabled && (
  (['public', 'synthetic'].includes(policy.classification) && Boolean(policy.classifiedBy && policy.classifiedAt))
  || (policy.allowed && Boolean(policy.approvedBy && policy.approvedAt))
);
export type ProviderOutput = { text: string; modelVersion: string | null; usage: { input_tokens?: number; output_tokens?: number } };
export interface InvoiceProvider { readonly name: ProviderName; readonly model: string; readonly endpointFingerprint: string;
  extract(context: ExtractionContext, signal: AbortSignal): Promise<ProviderOutput>; }
export class ProviderFailure extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly fallbackAllowed = true, readonly retryAfterMs = 0) { super(code); }
}
export type AttemptEvent = { provider: ProviderName; model: string; attempt: number; fallbackUsed: boolean; status: 'succeeded' | 'failed';
  schemaValid: boolean | null; durationMs: number; errorCode: string | null; modelVersion: string | null; usage: ProviderOutput['usage'] };
export type ExtractionOutcome = { provider: ProviderName | null; model: string | null; modelVersion: string | null;
  proposed: InvoiceExtraction | null; grounded: InvoiceExtraction | null; issues: { field: string; code: string }[];
  fallbackUsed: boolean; fallbackReason: string | null; attempts: AttemptEvent[]; errorCode: string | null; durationMs: number };
