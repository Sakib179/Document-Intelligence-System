import { describe, expect, it } from 'vitest';
import { extractionState } from '../../apps/web/src/lib/extraction-state.js';
import type { ResultData, ProgressData } from '../../apps/web/src/lib/types.js';
const result = (understanding: Record<string, unknown>) => ({ understanding } as ResultData);
const progress = (statuses: string[]) => ({ jobs: { items: statuses.map(status => ({ status })) } } as ProgressData);
describe('document extraction outcomes', () => {
  it('explains why successful exam-workbook processing produces no invoice', () => {
    const state = extractionState(result({ runId: 'run', invoiceCandidateCount: 0, requiresManualReview: true }), progress(['succeeded', 'succeeded']));
    expect(state.title).toBe('Source data extracted; no invoices detected');
    expect(state.message).toContain('requires review');
    expect(state.message).toContain('Invoice extraction was skipped');
  });
  it('does not call a completed non-invoice document pending', () => {
    expect(extractionState(result({ runId: 'run', invoiceCandidateCount: 0 }), progress(['succeeded'])).message).toContain('No invoice candidates');
  });
  it('reports active invoice processing', () => {
    expect(extractionState(result({ invoiceCandidateCount: 1 }), progress(['running'])).message).toContain('still running');
  });
  it('reports failed extraction rather than success', () => {
    expect(extractionState(result({ invoiceCandidateCount: 1 }), progress(['failed'])).title).toBe('Extraction needs attention');
  });
  it('does not infer no invoices before segmentation finishes', () => {
    expect(extractionState(null, progress(['queued'])).title).toBe('Invoice results are not ready');
  });
});
