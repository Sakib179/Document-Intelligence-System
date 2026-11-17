import type { ProgressData, ResultData } from './types.js';

/** Job success only describes that stage; it does not establish invoice extraction. */
export function extractionState(result: ResultData | null, progress: ProgressData | null) {
  const understanding = result?.understanding;
  if (understanding?.runId && understanding.invoiceCandidateCount === 0) {
    return {
      title: 'Source data extracted; no invoices detected',
      message: understanding.requiresManualReview
        ? 'Document classification is uncertain and requires review. Invoice extraction was skipped. The extracted worksheet cells or page text remain available in Original source.'
        : 'No invoice candidates were identified, so invoice extraction was skipped. The extracted worksheet cells or page text remain available in Original source.',
    };
  }
  const jobs = progress?.jobs.items ?? [];
  if (jobs.some(job => ['pending', 'queued', 'running', 'retry_wait'].includes(job.status)))
    return { title: 'Invoice results are not ready', message: 'Processing is still running. See Processing for the current stage.' };
  if (jobs.some(job => job.status === 'failed'))
    return { title: 'Extraction needs attention', message: 'A processing stage failed. See Processing for its error and recovery options. No invoice result has been produced.' };
  return { title: 'No invoice result available', message: 'Source processing and indexing do not guarantee an invoice result. See Processing for details.' };
}
