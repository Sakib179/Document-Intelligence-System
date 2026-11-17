import { FOUNDATION_JOB, foundationJobSchema, foundationJobResultSchema } from '@doc/contracts';
import type { FoundationJobResult } from '@doc/contracts';

// Operational probes are isolated from the document-ingestion queues.
export async function processFoundationJob(job: { name: string; data: unknown }): Promise<FoundationJobResult> {
  if (job.name !== FOUNDATION_JOB) throw new Error('Unsupported foundation job');
  foundationJobSchema.parse(job.data);
  return foundationJobResultSchema.parse({ completedAt: new Date().toISOString() });
}
