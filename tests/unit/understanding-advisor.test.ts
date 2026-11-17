import { expect, it, vi } from 'vitest';
import { adviseUnderstanding } from '../../apps/worker/src/understanding/advisor.js';
import type { AdviceInput, CloudApproval } from '../../apps/worker/src/understanding/advisor.js';
import type { AdvisorSuggestion } from '@doc/contracts';
import { invoice, page, understand } from '../fixtures/understanding.js';

const allowed: CloudApproval = { allowed: true, approvedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', approvedAt: '2026-11-15T00:00:00Z' };
const denied = { allowed: false, approvedBy: null, approvedAt: null };
const suggestion = { proposed_document_type: 'invoice' as const, same_invoice_as_previous: true, confidence: 0.9 };
function options() {
  return { enabled: true, maximumCalls: 5, advisor: { advise: vi.fn(async (_input: AdviceInput): Promise<AdvisorSuggestion> => suggestion) },
    approval: vi.fn(async (): Promise<CloudApproval> => allowed), beforeCall: vi.fn(async () => undefined) };
}

it('makes no provider or approval call when cloud advice is disabled', async () => {
  const config = options(); config.enabled = false;
  expect(await adviseUnderstanding(understand([page(1, 'Ambiguous source')]), config)).toBe('disabled');
  expect(config.approval).not.toHaveBeenCalled(); expect(config.advisor.advise).not.toHaveBeenCalled();
});
it('never requests AI for a sufficient deterministic classification', async () => {
  const config = options();
  expect(await adviseUnderstanding(understand([page(1, invoice('A'))]), config)).toBe('not_needed');
  expect(config.approval).not.toHaveBeenCalled(); expect(config.advisor.advise).not.toHaveBeenCalled();
});
it('never sends confidential text without document approval', async () => {
  const config = options(); config.approval.mockResolvedValue(denied);
  expect(await adviseUnderstanding(understand([page(1, 'Confidential unknown content')]), config)).toBe('not_permitted');
  expect(config.beforeCall).not.toHaveBeenCalled(); expect(config.advisor.advise).not.toHaveBeenCalled();
});
it('requires an approver and timestamp as well as the boolean', async () => {
  const config = options(); config.approval.mockResolvedValue({ ...denied, allowed: true });
  await adviseUnderstanding(understand([page(1, 'Unknown')]), config);
  expect(config.advisor.advise).not.toHaveBeenCalled();
});
it('audits before an approved call and keeps AI classification/merge suggestions separate', async () => {
  const config = options(); const order: string[] = [];
  config.beforeCall.mockImplementation(async () => { order.push('audit'); });
  config.advisor.advise.mockImplementation(async () => { order.push('provider'); return suggestion; });
  const result = understand([page(1, invoice('A')), page(2, 'Continued\nUnclear continuation')]);
  const count = result.candidates.length;
  expect(await adviseUnderstanding(result, config)).toBe('advised');
  expect(order[0]).toBe('audit'); expect(order[1]).toBe('provider');
  expect(result.candidates).toHaveLength(count);
  expect(result.documentType).toBe('unknown');
  expect(result.candidates.at(-1)?.document_type).toBe('unknown');
  expect(result.candidates.at(-1)?.advisor_suggestion).toEqual(suggestion);
  expect(result.candidates.at(-1)?.requires_manual_review).toBe(true);
});
it('does not call a provider when the durable audit checkpoint fails', async () => {
  const config = options(); config.beforeCall.mockRejectedValue(new Error('Database unavailable'));
  await expect(adviseUnderstanding(understand([page(1, 'Unknown')]), config)).rejects.toThrow('Database unavailable');
  expect(config.advisor.advise).not.toHaveBeenCalled();
});
it('rechecks approval between requests and honors revocation', async () => {
  const config = options(); config.approval.mockResolvedValueOnce(allowed).mockResolvedValueOnce(denied);
  const result = understand([page(1, 'First unknown'), page(2, 'Second unknown')]);
  await adviseUnderstanding(result, config);
  expect(config.advisor.advise).toHaveBeenCalledTimes(1);
  expect(result.warnings).toContain('CLOUD_APPROVAL_NOT_AVAILABLE');
});
it('bounds calls/excerpts and leaves remaining ambiguity visible', async () => {
  const config = options(); config.maximumCalls = 1;
  const result = understand([page(1, 'x'.repeat(2000)), page(2, 'second unknown')]);
  expect(await adviseUnderstanding(result, config)).toBe('budget_exhausted');
  expect(config.advisor.advise).toHaveBeenCalledTimes(1);
  expect(config.advisor.advise.mock.calls[0]?.[0].current_excerpt.length).toBeLessThanOrEqual(480);
  expect(result.candidates.every((candidate) => candidate.requires_manual_review)).toBe(true);
});
it('handles invalid/provider failure responses without inventing a result', async () => {
  const config = options(); config.advisor.advise.mockRejectedValue(new Error('Provider unavailable'));
  const result = understand([page(1, 'Unknown')]);
  expect(await adviseUnderstanding(result, config)).toBe('unavailable');
  expect(result.candidates[0]?.advisor_suggestion).toBeNull();
  expect(result.warnings).toContain('AI_ADVISOR_UNAVAILABLE');
});
