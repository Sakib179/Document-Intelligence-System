import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTenantTransaction, ambiguousCandidateReasons } from '@doc/database';
import { invoiceCandidateSchema, extractionJobPayloadSchema } from '@doc/contracts';
import type { ExtractionPayload, InvoiceCandidate } from '@doc/contracts';
import type { RuntimeEnvironment } from '@doc/core';
import { permitsCloud, ProviderFailure } from './types.js';
import type { AttemptEvent, CloudPolicy, ExtractionContext, ExtractionOutcome, InvoiceProvider } from './types.js';
import { EXTRACTION_PROMPT_VERSION } from './prompt.js';

export type ExtractionClaim = { token: string; candidate: InvoiceCandidate; sourceVersion: number };
export class ExtractionRepository {
  constructor(private readonly pool: pg.Pool, private readonly environment: RuntimeEnvironment) {}
  private tx<T>(payload: ExtractionPayload, reason: string, action: (client: pg.PoolClient) => Promise<T>) {
    return withTenantTransaction(this.pool, { tenantId: payload.tenantId, reason }, action);
  }
  async claim(
    payload: ExtractionPayload,
    providers?: { gemini: InvoiceProvider | null; local: InvoiceProvider | null },
  ): Promise<ExtractionClaim | { done: true } | { defer: number } | { terminal: true }> {
    return this.tx(payload, 'Claim a durable invoice extraction execution', async (client) => {
      const row = (await client.query(
        "SELECT j.*,d.metadata#>>'{understanding,runId}' AS active_run,d.processing_status,(j.execution_lease_until>clock_timestamp()) AS lease_active,EXTRACT(EPOCH FROM (j.execution_lease_until-clock_timestamp()))*1000 AS remaining_ms FROM public.processing_jobs j JOIN public.documents d ON (d.tenant_id,d.id)=(j.tenant_id,j.document_id) WHERE j.id=$1 AND j.job_type='extract' AND j.document_id=$2 FOR UPDATE OF j,d",
        [payload.jobId, payload.documentId],
      )).rows[0];
      if (!row || JSON.stringify(extractionJobPayloadSchema.parse(row.payload)) !== JSON.stringify(payload)) throw new ProviderFailure('EXTRACTION_REFERENCE_MISMATCH', false, false);
      if (row.status === 'succeeded') return { done: true };
      if (['failed', 'cancelled'].includes(row.status)) return { terminal: true };
      if (row.status === 'running' && row.lease_active) return { defer: Date.now() + Number(row.remaining_ms) + 100 };
      const candidate = (await client.query('SELECT c.data,r.source_version FROM public.invoice_candidates c JOIN public.document_understanding_runs r ON r.id=c.understanding_run_id AND r.tenant_id=c.tenant_id WHERE c.id=$1 AND c.document_id=$2', [payload.candidateId, payload.documentId])).rows[0];
      if (!candidate) throw new ProviderFailure('EXTRACTION_CANDIDATE_NOT_FOUND', false, false);
      const data = invoiceCandidateSchema.parse(candidate.data);
      if (row.active_run !== payload.understandingRunId || ['cancelled', 'rejected'].includes(row.processing_status)
        || data.document_type !== 'invoice' || data.review_reasons.some((code) => ambiguousCandidateReasons.has(code))) {
        await client.query("UPDATE public.processing_jobs SET status='cancelled',finished_at=clock_timestamp(),last_error_code='SOURCE_REQUIRES_REVIEW',execution_lease_token=NULL,execution_lease_until=NULL WHERE id=$1", [payload.jobId]);
        return { terminal: true };
      }
      if (row.attempts >= row.max_attempts) {
        await client.query("UPDATE public.processing_jobs SET status='failed',finished_at=clock_timestamp(),last_error_code='EXTRACTION_RECOVERY_EXHAUSTED',execution_lease_token=NULL,execution_lease_until=NULL WHERE id=$1", [payload.jobId]);
        return { terminal: true };
      }
      if (providers) {
        const policy = await this.policy(payload, client);
        const allowedProviders = [
          providers.gemini && permitsCloud(this.environment.CLOUD_LLM_ENABLED, policy) ? providers.gemini : null,
          providers.local ?? null,
        ].filter((provider): provider is InvoiceProvider => provider !== null);
        const circuitDeferrals = Number(row.checkpoint?.circuitDeferrals ?? 0);
        if (allowedProviders.length > 0 && circuitDeferrals < 2) {
          const openRemaining: number[] = [];
          for (const provider of allowedProviders) {
            const health = (await client.query<{ is_open: boolean; remaining_ms: number | null }>(
              'SELECT (circuit_open_until > clock_timestamp()) AS is_open, EXTRACT(EPOCH FROM (circuit_open_until - clock_timestamp())) * 1000 AS remaining_ms FROM public.llm_provider_health WHERE provider=$1 AND model_id=$2 AND endpoint_fingerprint=$3',
              [provider.name, provider.model, provider.endpointFingerprint],
            )).rows[0];
            if (health?.is_open && Number(health.remaining_ms) > 0) openRemaining.push(Number(health.remaining_ms));
          }
          if (openRemaining.length === allowedProviders.length) {
            const waitMs = Math.min(65_000, Math.max(500, Math.ceil(Math.min(...openRemaining)) + 250));
            await client.query(
              "UPDATE public.processing_jobs SET status='retry_wait',last_error_code='PROVIDER_CIRCUIT_OPEN',checkpoint=COALESCE(checkpoint,'{}'::jsonb)||jsonb_build_object('circuitDeferrals',$2::int,'stage','waiting_for_provider_circuit'),progress=jsonb_build_object('stage','waiting_for_provider_circuit') WHERE id=$1",
              [payload.jobId, circuitDeferrals + 1],
            );
            return { defer: Date.now() + waitMs };
          }
        }
      }
      await client.query("UPDATE public.extraction_attempts SET status='failed',finished_at=clock_timestamp(),error_code='WORKER_INTERRUPTED' WHERE extraction_run_id IN (SELECT id FROM public.extraction_runs WHERE processing_job_id=$1) AND status='running'", [payload.jobId]);
      await client.query("UPDATE public.extraction_runs SET status='failed',finished_at=clock_timestamp(),error_code='WORKER_INTERRUPTED',error_message='Execution was interrupted before completion' WHERE processing_job_id=$1 AND status='running'", [payload.jobId]);
      const token = randomUUID();
      await client.query("UPDATE public.processing_jobs SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,last_error_code=NULL,progress=jsonb_build_object('stage','extracting_invoice'),execution_lease_token=$2,execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1", [payload.jobId, token]);
      await client.query("INSERT INTO public.extraction_runs (id,tenant_id,document_id,processing_job_id,candidate_id,understanding_run_id,prompt_version,schema_version,status,started_at,source_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,'invoice-extraction-v1','running',clock_timestamp(),$8)",
        [token, payload.tenantId, payload.documentId, payload.jobId, payload.candidateId, payload.understandingRunId, EXTRACTION_PROMPT_VERSION,
          JSON.stringify({ source_version: candidate.source_version, candidate_id: payload.candidateId, selector_version: 'invoice-evidence-v1' })]);
      return { token, candidate: data, sourceVersion: candidate.source_version };
    });
  }

  async policy(payload: ExtractionPayload, client?: pg.PoolClient): Promise<CloudPolicy> {
    const read = async (connection: pg.PoolClient): Promise<CloudPolicy> => {
      const row = (await connection.query<CloudPolicy>('SELECT data_classification AS classification,data_classified_by AS "classifiedBy",data_classified_at::text AS "classifiedAt",cloud_processing_allowed AS allowed,cloud_approved_by AS "approvedBy",cloud_approved_at::text AS "approvedAt" FROM public.documents WHERE id=$1', [payload.documentId])).rows[0];
      if (!row) throw new Error('Source policy is unavailable'); return row;
    };
    return client ? read(client) : this.tx(payload, 'Check current extraction cloud policy', read);
  }

  private async fence(client: pg.PoolClient, payload: ExtractionPayload, token: string) {
    const row = (await client.query("SELECT j.id,d.metadata#>>'{understanding,runId}' AS active_run FROM public.processing_jobs j JOIN public.documents d ON (d.tenant_id,d.id)=(j.tenant_id,j.document_id) WHERE j.id=$1 AND j.execution_lease_token=$2 AND j.status='running' FOR UPDATE OF j,d", [payload.jobId, token])).rows[0];
    if (!row) throw new Error('EXTRACTION_LEASE_LOST');
    if (row.active_run !== payload.understandingRunId) throw new Error('EXTRACTION_SOURCE_CHANGED');
  }
  async attachContext(payload: ExtractionPayload, token: string, context: ExtractionContext) {
    await this.tx(payload, 'Record bounded extraction source selection', async (client) => {
      await this.fence(client, payload, token);
      await client.query("UPDATE public.extraction_runs SET source_reference=source_reference || $2::jsonb WHERE id=$1 AND status='running'", [token,
        JSON.stringify({ input_sha256: context.digest, source_ids: context.sources.map((source) => source.id), context_warnings: context.warnings })]);
    });
  }
  async beginAttempt(payload: ExtractionPayload, token: string, context: ExtractionContext, provider: InvoiceProvider, number: number, fallback: boolean) {
    const outcome = await this.tx(payload, 'Record an authorized provider request before network dispatch', async (client) => {
      await this.fence(client, payload, token);
      const policy = await this.policy(payload, client);
      if (provider.name === 'gemini' && !permitsCloud(this.environment.CLOUD_LLM_ENABLED, policy)) return { denied: true };
      await client.query('INSERT INTO public.llm_provider_health (tenant_id,provider,model_id,endpoint_fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [payload.tenantId, provider.name, provider.model, provider.endpointFingerprint]);
      const health = (await client.query('SELECT id,(circuit_open_until>clock_timestamp()) AS is_open FROM public.llm_provider_health WHERE provider=$1 AND model_id=$2 AND endpoint_fingerprint=$3 FOR UPDATE', [provider.name, provider.model, provider.endpointFingerprint])).rows[0];
      const id = randomUUID();
      await client.query("INSERT INTO public.extraction_attempts (id,tenant_id,document_id,extraction_run_id,provider,model_id,prompt_version,attempt_number,fallback_used,status,input_sha256,policy_snapshot,error_code,finished_at,processing_time_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $14::boolean THEN clock_timestamp() ELSE NULL END,CASE WHEN $14::boolean THEN 0 ELSE NULL END)",
        [id, payload.tenantId, payload.documentId, token, provider.name, provider.model, EXTRACTION_PROMPT_VERSION, number, fallback,
          health.is_open ? 'failed' : 'running', context.digest, JSON.stringify({ global_enabled: this.environment.CLOUD_LLM_ENABLED, ...policy }),
          health.is_open ? 'PROVIDER_CIRCUIT_OPEN' : null, Boolean(health.is_open)]);
      if (provider.name === 'gemini') await client.query('UPDATE public.extraction_runs SET cloud_approval_snapshot=$2 WHERE id=$1', [token, JSON.stringify(policy)]);
      return { id, open: Boolean(health.is_open) };
    });
    if ('denied' in outcome) throw new ProviderFailure('CLOUD_PROCESSING_NOT_PERMITTED');
    if (outcome.open) throw new ProviderFailure('PROVIDER_CIRCUIT_OPEN');
    return outcome.id;
  }
  async endAttempt(payload: ExtractionPayload, token: string, provider: InvoiceProvider, id: string, event: AttemptEvent) {
    await this.tx(payload, 'Persist provider completion and protocol health', async (client) => {
      await this.fence(client, payload, token);
      const updated = await client.query("UPDATE public.extraction_attempts SET status=$2,finished_at=clock_timestamp(),schema_valid=$3,error_code=$4,processing_time_ms=$5,model_version=$6,usage_metadata=$7 WHERE id=$1 AND status='running' RETURNING id",
        [id, event.status, event.schemaValid, event.errorCode, event.durationMs, event.modelVersion?.slice(0, 128) ?? null, JSON.stringify(event.usage)]);
      if (!updated.rowCount) throw new Error('Attempt completion is unavailable');
      if (event.status === 'succeeded') await client.query("UPDATE public.llm_provider_health SET consecutive_failures=0,success_count=success_count+1,last_success_at=clock_timestamp(),last_error_code=NULL,circuit_open_until=NULL WHERE provider=$1 AND model_id=$2 AND endpoint_fingerprint=$3", [provider.name, provider.model, provider.endpointFingerprint]);
      else await client.query("UPDATE public.llm_provider_health SET consecutive_failures=CASE WHEN circuit_open_until IS NOT NULL AND circuit_open_until<=clock_timestamp() THEN 1 ELSE consecutive_failures+1 END,failure_count=failure_count+1,last_failure_at=clock_timestamp(),last_error_code=$4,circuit_open_until=CASE WHEN (CASE WHEN circuit_open_until IS NOT NULL AND circuit_open_until<=clock_timestamp() THEN 1 ELSE consecutive_failures+1 END)>=$5 THEN clock_timestamp()+make_interval(secs=>$6) ELSE NULL END WHERE provider=$1 AND model_id=$2 AND endpoint_fingerprint=$3",
        [provider.name, provider.model, provider.endpointFingerprint, event.errorCode, this.environment.LLM_CIRCUIT_FAILURES, this.environment.LLM_CIRCUIT_SECONDS]);
    });
  }

  async complete(payload: ExtractionPayload, claim: ExtractionClaim, outcome: ExtractionOutcome) {
    return this.tx(payload, 'Publish grounded extraction result without financial approval', async (client) => {
      await this.fence(client, payload, claim.token);
      const success = outcome.grounded !== null && outcome.proposed !== null;
      await client.query("UPDATE public.extraction_runs SET status=$2,finished_at=clock_timestamp(),provider=$3,model_id=$4,model_version=$5,fallback_used=$6,processing_time_ms=$7,schema_valid=$8,error_code=$9,error_message=$10,structured_result=$11,response_metadata=$12 WHERE id=$1 AND status='running'",
        [claim.token, success ? 'succeeded' : 'failed', outcome.provider, outcome.model, outcome.modelVersion, outcome.fallbackUsed, outcome.durationMs,
          success ? true : outcome.attempts.at(-1)?.schemaValid ?? null, outcome.errorCode, outcome.errorCode ? 'No provider produced a valid extraction result' : null,
          success ? JSON.stringify({ schema_version: 'invoice-extraction-v1', proposed: outcome.proposed, grounded: outcome.grounded, issues: outcome.issues }) : null,
          JSON.stringify({ fallback_reason: outcome.fallbackReason, attempts: outcome.attempts, financially_validated: false, requires_manual_review: true })]);
      let invoiceId: string | null = null;
      if (outcome.grounded) {
        const result = outcome.grounded;
        const page = (await client.query('SELECT id FROM public.document_pages WHERE document_id=$1 AND source_version=$2 AND page_number=$3', [payload.documentId, claim.sourceVersion, claim.candidate.source_pages[0]])).rows[0];
        const headerEvidence = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'line_items'));
        invoiceId = (await client.query("INSERT INTO public.invoices (tenant_id,source_document_id,source_page_id,source_candidate_id,extraction_run_id,segment_number,invoice_number,invoice_date,supplier_name,customer_name,subtotal,tax,total,currency,field_evidence,extraction_metadata,review_status) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'needs_review') RETURNING id",
          [payload.tenantId, payload.documentId, page?.id ?? null, payload.candidateId, claim.token, result.invoice_number.value, result.invoice_date.value,
            result.supplier_name.value, result.customer_name.value, result.subtotal.value, result.tax.value, result.total.value, result.currency.value,
            JSON.stringify(headerEvidence), JSON.stringify({ provider: outcome.provider, model_id: outcome.model, prompt_version: EXTRACTION_PROMPT_VERSION,
              source_version: claim.sourceVersion, candidate_id: payload.candidateId, fallback_used: outcome.fallbackUsed, financially_validated: false })])).rows[0].id;
        for (const [index, item] of result.line_items.entries()) await client.query('INSERT INTO public.invoice_line_items (tenant_id,invoice_id,source_document_id,line_number,description,quantity,unit_price,tax_rate,line_total,source_evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [payload.tenantId, invoiceId, payload.documentId, index + 1, item.description.value, item.quantity.value, item.unit_price.value, item.tax_rate.value, item.line_total.value, JSON.stringify(item)]);
        for (const issue of outcome.issues) await client.query("INSERT INTO public.validation_issues (tenant_id,document_id,invoice_id,extraction_run_id,issue_code,severity,field_path,message,source_evidence) VALUES ($1,$2,$3,$4,$5,'warning',$6,'Source evidence or value requires manual review',$7)",
          [payload.tenantId, payload.documentId, invoiceId, claim.token, 'EXTRACTION_' + issue.code, issue.field, JSON.stringify({ candidate_id: payload.candidateId })]);
      }
      await client.query("UPDATE public.processing_jobs SET status=$3,finished_at=clock_timestamp(),execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$4,last_error_message=$5,checkpoint=$6,progress=$7 WHERE id=$1 AND execution_lease_token=$2",
        [payload.jobId, claim.token, success ? 'succeeded' : 'failed', outcome.errorCode, success ? null : 'Invoice extraction failed; provider history is retained',
          JSON.stringify({ stage: 'invoice_extraction_complete', extractionRunId: claim.token, invoiceId, provider: outcome.provider, fallbackUsed: outcome.fallbackUsed, financiallyValidated: false }), JSON.stringify({ completed: true })]);
      await client.query("UPDATE public.documents SET processing_status=CASE WHEN processing_status IN ('processed','needs_review') THEN 'needs_review' ELSE processing_status END,metadata=jsonb_set(metadata,'{extraction}',$2) WHERE id=$1",
        [payload.documentId, JSON.stringify({ lastJobId: payload.jobId, lastRunId: claim.token, lastStatus: success ? 'needs_review' : 'failed' })]);
      return { success, invoiceId };
    });
  }

  async interrupt(payload: ExtractionPayload, token: string, code: string) {
    await this.tx(payload, 'Persist extraction interruption for bounded recovery', async (client) => {
      const row = (await client.query("SELECT attempts,max_attempts FROM public.processing_jobs WHERE id=$1 AND execution_lease_token=$2 AND status='running' FOR UPDATE", [payload.jobId, token])).rows[0];
      if (!row) return;
      await client.query("UPDATE public.extraction_attempts SET status='failed',finished_at=clock_timestamp(),error_code=$2 WHERE extraction_run_id=$1 AND status='running'", [token, code]);
      await client.query("UPDATE public.extraction_runs SET status='failed',finished_at=clock_timestamp(),error_code=$2,error_message='Extraction execution could not complete' WHERE id=$1 AND status='running'", [token, code]);
      const terminal = row.attempts >= row.max_attempts || code.startsWith('SOURCE_') || code === 'NO_USABLE_SOURCE_EVIDENCE';
      await client.query("UPDATE public.processing_jobs SET status=$3,finished_at=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END,execution_lease_token=NULL,execution_lease_until=NULL,last_error_code=$5,last_error_message='Extraction interruption is retained for review or recovery' WHERE id=$1 AND execution_lease_token=$2",
        [payload.jobId, token, terminal ? 'failed' : 'retry_wait', terminal, code]);
    });
  }
  async heartbeat(payload: ExtractionPayload, token: string) {
    await this.tx(payload, 'Renew invoice extraction execution lease', (client) => client.query("UPDATE public.processing_jobs SET execution_lease_until=clock_timestamp()+interval '180 seconds' WHERE id=$1 AND execution_lease_token=$2 AND status='running'", [payload.jobId, token]));
  }
}
