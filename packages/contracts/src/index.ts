import { z } from 'zod';

export const serviceNameSchema = z.enum(['api', 'worker', 'document-processor', 'web']);
export const checkResultSchema = z.object({ status: z.enum(['ok', 'error']) }).strict();
export const healthResponseSchema = z.object({
  service: serviceNameSchema,
  status: z.enum(['ok', 'error']),
  timestamp: z.iso.datetime(),
  checks: z.record(z.string(), checkResultSchema).optional(),
}).strict();

export const foundationJobSchema = z.object({ requestedAt: z.iso.datetime() }).strict();
export const foundationJobResultSchema = z.object({ completedAt: z.iso.datetime() }).strict();
export const FOUNDATION_QUEUE = 'foundation-health';
export const FOUNDATION_JOB = 'healthcheck';

export const systemHealthResponseSchema = z.object({
  services: z.array(healthResponseSchema),
  checkedAt: z.iso.datetime(),
}).strict();

export type ServiceName = z.infer<typeof serviceNameSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type FoundationJob = z.infer<typeof foundationJobSchema>;
export type FoundationJobResult = z.infer<typeof foundationJobResultSchema>;
export type SystemHealthResponse = z.infer<typeof systemHealthResponseSchema>;
export * from './ingestion.js';
export * from './processing.js';
export * from './understanding.js';
export * from './extraction.js';
export * from './finance.js';
export * from './search.js';
export * from './workflow.js';
export * from './workspace.js';
