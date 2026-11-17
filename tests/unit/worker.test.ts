import { expect, it } from 'vitest';
import { FOUNDATION_JOB, foundationJobResultSchema } from '@doc/contracts';
import { processFoundationJob } from '../../apps/worker/src/processor.js';

it('rejects document work on the isolated operational probe queue', async () => {
  await expect(processFoundationJob({ name: 'process-document', data: {} })).rejects.toThrow('Unsupported foundation job');
});
it('rejects malformed operational job data', async () => {
  await expect(processFoundationJob({ name: FOUNDATION_JOB, data: { requestedAt: null } })).rejects.toThrow();
});
it('completes a schema-validated operational health probe', async () => {
  const result = await processFoundationJob({ name: FOUNDATION_JOB, data: { requestedAt: new Date().toISOString() } });
  expect(foundationJobResultSchema.safeParse(result).success).toBe(true);
});
