import type pg from 'pg';
import { ServiceError } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { withTenantTransaction, WorkflowRepository } from '@doc/database';
/** PostgreSQL-backed orchestration, independent of Redis availability. */
export class WorkflowRunner {
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private pool: pg.Pool, private dispatcher: pg.Pool, private env: RuntimeEnvironment, private report: () => void) { }
  start() {
    if (!this.env.WORKFLOW_ENABLED || this.timer)
      return; this.timer = setInterval(() => { void this.tick().catch(this.report); }, this.env.OUTBOX_POLL_MS); this.timer.unref(); void this.tick().catch(this.report);
  }
  tick() { return this.active ??= (this.run().finally(() => { this.active = undefined; })); }
  private async run() {
    const job = (await this.dispatcher.query('SELECT * FROM public.claim_workflow_job()')).rows[0];
    if (!job)
      return;
    const context = { tenantId: job.tenant_id, reason: 'Persist durable workflow progress' };
    const heartbeat = setInterval(() => { void withTenantTransaction(this.pool, context, client => client.query("UPDATE public.processing_jobs SET execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1 AND execution_lease_token=$2 AND status='running'", [job.id, job.execution_lease_token])).catch(this.report); }, 30000);
    heartbeat.unref();
    try {
      const outcome = await new WorkflowRepository(this.pool, this.env).execute(job, async (stage) => { await withTenantTransaction(this.pool, context, client => client.query("UPDATE public.processing_jobs SET progress=jsonb_build_object('stage',$3::text) WHERE id=$1 AND execution_lease_token=$2 AND status='running'", [job.id, job.execution_lease_token, stage])); }), waiting = outcome === 'waiting';
      await withTenantTransaction(this.pool, context, client => client.query("UPDATE public.processing_jobs SET status=$3,attempts=attempts-CASE WHEN $4 THEN 1 ELSE 0 END,finished_at=CASE WHEN $4 THEN NULL ELSE clock_timestamp() END,dispatch_available_at=clock_timestamp()+interval '2 seconds',execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=NULL,progress=$5 WHERE id=$1 AND execution_lease_token=$2", [job.id, job.execution_lease_token, waiting ? 'retry_wait' : 'succeeded', waiting, JSON.stringify({ stage: waiting ? 'waiting_for_extraction' : 'workflow_scheduled', completed: !waiting })]));
    }
    catch (error) {
      const code = error instanceof ServiceError ? error.code : 'WORKFLOW_UNAVAILABLE', terminal = job.attempts >= job.max_attempts || (error instanceof ServiceError && error.statusCode < 500);
      await withTenantTransaction(this.pool, context, client => client.query("UPDATE public.processing_jobs SET status=$3,finished_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,dispatch_available_at=clock_timestamp()+make_interval(secs=>LEAST(60,power(2,attempts)::integer)),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$5 WHERE id=$1 AND execution_lease_token=$2", [job.id, job.execution_lease_token, terminal ? 'failed' : 'retry_wait', terminal, code]));
    }
    finally {
      clearInterval(heartbeat);
    }
  }
  async stop() {
    if (this.timer)
      clearInterval(this.timer); this.timer = undefined; await this.active;
  }
}
