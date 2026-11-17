import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type pg from 'pg';
import { withTenantTransaction } from '@doc/database';
import { Worker } from 'bullmq';
import { createRedis } from '@doc/core';
import type { RuntimeEnvironment } from '@doc/core';
import { extractionResultsSchema } from '@doc/contracts';
import { buildApi } from '../fixtures/workspace-api.js';
import { selectWorkspace } from '../fixtures/workspace-api.js';
import { buildWorker } from '../../apps/worker/src/app.js';
import { InvoiceExtractionProcessor } from '../../apps/worker/src/extraction/processor.js';
import { GeminiInvoiceProvider, LocalQwenInvoiceProvider } from '../../apps/worker/src/extraction/providers.js';
import type { EvidenceSource } from '../../apps/worker/src/extraction/types.js';
import { mockInvoice } from '../fixtures/extraction.js';

type Resources = {
  environment: RuntimeEnvironment; database: pg.Pool; admin: pg.Pool; fixtures: string;
  api: ReturnType<typeof buildApi>; worker: ReturnType<typeof buildWorker>; workspace: string; otherWorkspace: string; readerWorkspace: string;
  query: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
  waitFor: (predicate: () => Promise<boolean>, timeout?: number) => Promise<void>;
  upload: (files: { filename: string; mime?: string; content: Buffer }[]) => Promise<{ statusCode: number; body: string; json(): any }>;
};
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REVIEWER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
type Mode = 'ok' | 'unavailable' | 'rate_limit' | 'schema' | 'ungrounded' | 'refusal';

/** Real HTTP/SQL/queue integration. Both model transports are controlled fixtures, never external calls. */
export function registerExtractionTests(resources: () => Resources) {
  describe('AI extraction through private HTTP, PostgreSQL and BullMQ', { concurrency: false }, () => {
    let r: Resources, api: ReturnType<typeof buildApi>, consumer: Worker, connection: ReturnType<typeof createRedis>;
    let aiEnvironment: RuntimeEnvironment, administrator: string, reviewer: string;
    let geminiMode: Mode = 'ok', localMode: Mode = 'ok';
    let geminiCalls = 0, localCalls = 0;
    const sentSources: EvidenceSource[][] = [];
    const server = createServer(async (request, response) => {
      try {
        localCalls++;
        assert.equal(request.url, '/v1/chat/completions');
        let body = ''; for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(body);
        assert.equal(payload.tools, undefined);
        const sources: EvidenceSource[] = JSON.parse(payload.messages[1].content).sources;
        sentSources.push(sources);
        if (localMode === 'unavailable') { response.writeHead(503); response.end('{}'); return; }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ model: 'qwen-fixture-instruct', system_fingerprint: 'qwen-fixture-v1',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(mockInvoice(sources)) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }));
      } catch { response.writeHead(500); response.end('{}'); }
    });
    before(async () => {
      r = resources();
      await r.worker.extractions.pause();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      aiEnvironment = { ...r.environment, CLOUD_LLM_ENABLED: true, GEMINI_MODEL: 'gemini-fixture', GEMINI_API_KEY: 'test-only-gemini-key-not-real',
        LOCAL_LLM_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', LOCAL_LLM_MODEL: 'qwen-fixture-instruct',
        LLM_RETRY_BASE_MS: 10, LLM_RETRY_MAX_MS: 100, LLM_TIMEOUT_MS: 1_000 };
      const gemini = new GeminiInvoiceProvider(aiEnvironment.GEMINI_MODEL, aiEnvironment.GEMINI_API_KEY, 1_000, async (_url, init) => {
        geminiCalls++;
        const body = JSON.parse(String(init?.body));
        const sources: EvidenceSource[] = JSON.parse(body.contents[0].parts[0].text).sources;
        sentSources.push(sources);
        if (geminiMode === 'unavailable' || geminiMode === 'rate_limit') return new Response(JSON.stringify({ error: { code: geminiMode === 'rate_limit' ? 429 : 503, message: 'Controlled fixture failure' } }), { status: geminiMode === 'rate_limit' ? 429 : 503 });
        const result = mockInvoice(sources);
        if (geminiMode === 'ungrounded') result.total.value = '999.00';
        return Response.json({ modelVersion: 'gemini-fixture-v1', candidates: [{ finishReason: geminiMode === 'refusal' ? 'SAFETY' : 'STOP',
          content: { role: 'model', parts: [{ text: geminiMode === 'schema' ? '{"not_an_invoice":true}' : JSON.stringify(result) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } });
      });
      const local = new LocalQwenInvoiceProvider(aiEnvironment.LOCAL_LLM_MODEL, aiEnvironment.LOCAL_LLM_BASE_URL, ['127.0.0.1']);
      const processor = new InvoiceExtractionProcessor(r.database, aiEnvironment, { gemini, local });
      connection = createRedis(aiEnvironment, true);
      consumer = new Worker('extraction-queue', (job, lease) => processor.process(job, lease), { connection, prefix: aiEnvironment.QUEUE_PREFIX, concurrency: 1 });
      consumer.on('error', () => undefined);
      await consumer.waitUntilReady();
      api = buildApi(aiEnvironment); await api.ready();
      await r.admin.query("INSERT INTO public.users (id,tenant_id,email,display_name,role) VALUES ($1,$2,'administrator@example.invalid','Fixture administrator','admin')", [ADMIN, TENANT]);
      administrator = await selectWorkspace(aiEnvironment, { tenantId: TENANT, userId: ADMIN });
      await r.admin.query("INSERT INTO public.users (id,tenant_id,email,display_name,role) VALUES ($1,$2,'extraction-reviewer@example.invalid','Fixture reviewer','reviewer')", [REVIEWER, TENANT]);
      reviewer = await selectWorkspace(aiEnvironment, { tenantId: TENANT, userId: REVIEWER });
    });
    after(async () => {
      if (consumer) await consumer.close();
      connection?.disconnect();
      if (api) await api.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (r) await r.worker.extractions.resume();
    });
    async function document(name = 'ai-invoice.pdf') {
      const uploaded = await r.upload([{ filename: name, mime: 'application/pdf', content: await readFile(join(r.fixtures, name)) }]);
      assert.equal(uploaded.statusCode, 202, uploaded.body);
      const id: string = uploaded.json().documents[0].id;
      await r.waitFor(async () => (await r.query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='processed'", [id])).rowCount === 1);
      return id;
    }
    async function privacy(id: string, classification = 'synthetic', allowed = false, bearer = administrator) {
      return api.inject({ method: 'PATCH', url: `/v1/documents/${id}/privacy`, headers: { 'x-test-workspace':  bearer },
        payload: { data_classification: classification, cloud_processing_allowed: allowed, reason: 'Controlled synthetic extraction fixture' } });
    }
    async function start(id: string, key = randomUUID()) {
      const response = await api.inject({ method: 'POST', url: `/v1/documents/${id}/extractions`, headers: { 'x-test-workspace':  r.workspace, 'idempotency-key': key }, payload: {} });
      assert.equal(response.statusCode, 202, response.body);
      return { ...response.json(), key };
    }
    async function results(id: string) {
      const response = await api.inject({ url: `/v1/documents/${id}/extractions`, headers: { 'x-test-workspace':  r.workspace } });
      assert.equal(response.statusCode, 200, response.body);
      return extractionResultsSchema.parse(response.json());
    }
    async function finished(id: string, jobId: string) {
      await r.waitFor(async () => (await r.query("SELECT id FROM public.processing_jobs WHERE id=$1 AND status IN ('succeeded','failed','cancelled')", [jobId])).rowCount === 1);
      const job = (await r.query("SELECT checkpoint->>'extractionRunId' AS run_id FROM public.processing_jobs WHERE id=$1", [jobId])).rows[0];
      const run = (await results(id)).runs.find((entry) => entry.id === job.run_id);
      assert.ok(run, 'Completed job must retain its extraction run'); return run;
    }
    async function clearCircuit() {
      await r.query('UPDATE public.llm_provider_health SET consecutive_failures=0,circuit_open_until=NULL');
      geminiMode = 'ok'; localMode = 'ok';
    }

    it('keeps confidential documents local despite global cloud enablement and stores evidence and exact decimals', async () => {
      const id = await document(), beforeGemini = geminiCalls, beforeLocal = localCalls;
      const accepted = await start(id), run = await finished(id, accepted.jobs[0].id);
      assert.equal(geminiCalls, beforeGemini); assert.equal(localCalls, beforeLocal + 1);
      assert.equal(run.provider, 'local_qwen'); assert.equal(run.fallback_used, false);
      assert.equal(run.model_version, 'qwen-fixture-v1'); assert.equal(run.schema_valid, true);
      assert.equal(run.prompt_version, 'invoice-extraction-v1'); assert.ok(run.processing_time_ms !== null);
      assert.equal(run.invoice?.invoice_number, 'INV-101'); assert.equal(run.invoice?.total, '115.00000000');
      assert.equal(run.invoice?.original_values.total, '115.00000000'); assert.equal(run.invoice?.review_status, 'needs_review');
      assert.equal(run.invoice?.line_items[0]?.tax_rate, '0.150000');
      assert.equal(run.result?.grounded.total.evidence?.page, 1); assert.equal(run.result?.grounded.total.raw_value, '115.00');
      assert.equal(sentSources.at(-1)?.some((source) => /Grand Total/.test(source.text)), true);
    });

    it('enforces administrator-only, audited cloud classification in both HTTP and SQL', async () => {
      const id = await document();
      assert.equal((await privacy(id, 'public', false, reviewer)).statusCode, 403);
      await assert.rejects(withTenantTransaction(r.database, { tenantId: TENANT, actorUserId: REVIEWER, reason: 'Unauthorized fixture approval' },
        (client) => client.query("UPDATE public.documents SET data_classification='public' WHERE id=$1", [id])), { code: '42501' });
      const approved = await privacy(id);
      assert.equal(approved.statusCode, 200, approved.body); assert.equal(approved.json().data_classified_by, ADMIN);
      assert.equal(approved.json().gemini_permitted, true);
      const beforeLocal = localCalls, beforeGemini = geminiCalls;
      const accepted = await start(id), run = await finished(id, accepted.jobs[0].id);
      assert.equal(run.provider, 'gemini'); assert.equal(geminiCalls, beforeGemini + 1); assert.equal(localCalls, beforeLocal);
      const audit = await r.query("SELECT id FROM public.audit_events WHERE entity_id=$1 AND actor_user_id=$2", [id, ADMIN]);
      assert.ok(audit.rowCount! > 0);
      const attempt = (await r.query('SELECT policy_snapshot FROM public.extraction_attempts WHERE extraction_run_id=$1', [run.id])).rows[0];
      assert.equal(attempt.policy_snapshot.classification, 'synthetic');
    });

    it('requires explicit approval before sending a confidential document to Gemini', async () => {
      const id = await document(); const approval = await privacy(id, 'confidential', true);
      assert.equal(approval.statusCode, 200, approval.body); assert.equal(approval.json().cloud_approved_by, ADMIN);
      const accepted = await start(id), run = await finished(id, accepted.jobs[0].id);
      assert.equal(run.provider, 'gemini'); assert.equal(run.fallback_used, false);
    });

    it('extracts separate spreadsheet records with exact worksheet and cell evidence', async () => {
      const response = await r.upload([{ filename: 'ai-ledger.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: await readFile(join(r.fixtures, 'ai-ledger.xlsx')) }]);
      assert.equal(response.statusCode, 202, response.body); const id = response.json().documents[0].id;
      await r.waitFor(async () => (await r.query("SELECT id FROM public.documents WHERE id=$1 AND processing_status='processed'", [id])).rowCount === 1);
      const sourceOffset = sentSources.length, accepted = await start(id);
      assert.equal(accepted.jobs.length, 2);
      for (const job of accepted.jobs) await finished(id, job.id);
      const history = await results(id), invoice = history.runs.find((run) => run.invoice?.invoice_number === 'INV-101');
      assert.ok(invoice); assert.equal(invoice.result?.grounded.total.evidence?.worksheet, 'Invoice ledger');
      assert.equal(invoice.result?.grounded.total.evidence?.cell, 'G2');
      assert.equal(invoice.result?.grounded.invoice_number.evidence?.cell, 'A2');
      const calls = sentSources.slice(sourceOffset);
      assert.equal(calls.length, 2);
      assert.ok(calls.some((sources) => sources.some((source) => source.text === 'INV-102')));
      assert.ok(calls.every((sources) => !(sources.some((source) => source.text === 'INV-101') && sources.some((source) => source.text === 'INV-102'))));
    });

    it('retries rate limits a bounded number of times, falls back locally, and opens the persisted circuit', async () => {
      await clearCircuit(); const id = await document(); await privacy(id); geminiMode = 'rate_limit';
      const before = geminiCalls, accepted = await start(id), run = await finished(id, accepted.jobs[0].id);
      assert.equal(geminiCalls - before, 3); assert.equal(run.provider, 'local_qwen'); assert.equal(run.fallback_used, true);
      assert.equal(run.attempts.length, 4); assert.equal(run.attempts[0]?.error_code, 'PROVIDER_RATE_LIMITED');
      assert.equal(run.attempts[3]?.fallback_used, true);
      const health = await api.inject({ url: '/v1/providers/health', headers: { 'x-test-workspace':  r.workspace } });
      assert.equal(health.statusCode, 200); assert.equal(health.json().providers.find((row: any) => row.provider === 'gemini').status, 'open');
      const second = await start(id), run2 = await finished(id, second.jobs[0].id);
      assert.equal(geminiCalls - before, 3); assert.equal(run2.attempts[0]?.error_code, 'PROVIDER_CIRCUIT_OPEN');
      assert.equal(run2.provider, 'local_qwen'); await clearCircuit();
    });

    it('falls back for malformed structured output, but preserves business uncertainty without provider fallback', async () => {
      await clearCircuit(); const id = await document(); await privacy(id); geminiMode = 'schema';
      const accepted = await start(id), malformed = await finished(id, accepted.jobs[0].id);
      assert.equal(malformed.provider, 'local_qwen'); assert.equal(malformed.attempts[0]?.schema_valid, false);
      await clearCircuit(); geminiMode = 'ungrounded'; const beforeLocal = localCalls;
      const next = await start(id), uncertain = await finished(id, next.jobs[0].id);
      assert.equal(uncertain.provider, 'gemini'); assert.equal(localCalls, beforeLocal);
      assert.equal(uncertain.result?.proposed.total.value, '999.00'); assert.equal(uncertain.result?.grounded.total.value, null);
      assert.equal(uncertain.invoice?.total, null); assert.ok(uncertain.result?.issues.some((issue) => issue.field === 'total'));
      assert.ok((await r.query('SELECT id FROM public.validation_issues WHERE extraction_run_id=$1', [uncertain.id])).rowCount! > 0);
      await clearCircuit();
    });

    it('retains both-provider failures, creates no invoice, and permits explicit recovery with a new key', async () => {
      await clearCircuit(); const id = await document(); await privacy(id); geminiMode = localMode = 'unavailable';
      const beforeGemini = geminiCalls, beforeLocal = localCalls, accepted = await start(id), failed = await finished(id, accepted.jobs[0].id);
      assert.equal(failed.status, 'failed'); assert.equal(failed.invoice, null); assert.equal(failed.result, null);
      assert.equal(failed.attempts.length, 6); assert.equal(geminiCalls - beforeGemini, 3); assert.equal(localCalls - beforeLocal, 3);
      const job = (await r.query('SELECT status,last_error_code FROM public.processing_jobs WHERE id=$1', [accepted.jobs[0].id])).rows[0];
      assert.equal(job.status, 'failed'); assert.equal(job.last_error_code, 'PROVIDER_UNAVAILABLE');
      const repeat = await start(id, accepted.key); assert.equal(repeat.jobs[0].id, accepted.jobs[0].id);
      await clearCircuit(); const retry = await start(id), recovered = await finished(id, retry.jobs[0].id);
      assert.equal(recovered.status, 'succeeded'); assert.equal((await results(id)).runs.length, 2);
    });

    it('keeps finalized attempts immutable and creates new snapshots without overwriting manual corrections', async () => {
      const id = await document(), accepted = await start(id), first = await finished(id, accepted.jobs[0].id);
      assert.ok(first.invoice);
      await r.query("UPDATE public.invoices SET customer_name='Manually corrected buyer' WHERE id=$1", [first.invoice.id]);
      const attempt = (await r.query('SELECT id FROM public.extraction_attempts WHERE extraction_run_id=$1', [first.id])).rows[0];
      await assert.rejects(r.query("UPDATE public.extraction_attempts SET model_version='forged' WHERE id=$1", [attempt.id]), { code: '23514' });
      const before = localCalls, repeat = await start(id, accepted.key); assert.equal(repeat.jobs[0].id, accepted.jobs[0].id);
      assert.equal(localCalls, before);
      const next = await start(id), second = await finished(id, next.jobs[0].id);
      assert.notEqual(second.invoice?.id, first.invoice.id);
      const history = await results(id), original = history.runs.find((row) => row.id === first.id)!;
      assert.equal(original.invoice?.customer_name, 'Manually corrected buyer');
      assert.equal(original.invoice?.original_values.customer_name, 'Example Buyer');
      const page = await api.inject({ url: `/v1/documents/${id}/extractions?limit=1`, headers: { 'x-test-workspace':  r.workspace } });
      assert.ok(page.json().next_cursor);
      const older = await api.inject({ url: `/v1/documents/${id}/extractions?limit=1&cursor=${page.json().next_cursor}`, headers: { 'x-test-workspace':  r.workspace } });
      assert.equal(older.json().runs[0].id, first.id);
    });

    it('does not fall back on a model refusal and preserves the terminal reason', async () => {
      await clearCircuit(); const id = await document(); await privacy(id); geminiMode = 'refusal'; const before = localCalls;
      const accepted = await start(id), run = await finished(id, accepted.jobs[0].id);
      assert.equal(run.status, 'failed'); assert.equal(run.error_code, 'PROVIDER_REFUSAL'); assert.equal(localCalls, before);
      await clearCircuit();
    });

    it('optionally schedules extraction atomically after understanding and consumes it in the application worker', async () => {
      await consumer.pause(); await r.worker.documents.pause();
      const automatic = buildWorker({ ...aiEnvironment, CLOUD_LLM_ENABLED: false, EXTRACTION_AUTO_START: true });
      try {
        await automatic.app.ready(); await automatic.documents.waitUntilReady(); await automatic.extractions.waitUntilReady();
        const response = await r.upload([{ filename:'ai-invoice.pdf',mime:'application/pdf',content:await readFile(join(r.fixtures,'ai-invoice.pdf')) }]);
        assert.equal(response.statusCode,202,response.body); const id = response.json().documents[0].id;
        await r.waitFor(async () => (await r.query("SELECT id FROM public.processing_jobs WHERE document_id=$1 AND job_type='extract' AND status='succeeded'",[id])).rowCount === 1);
        const job = (await r.query("SELECT * FROM public.processing_jobs WHERE document_id=$1 AND job_type='extract'",[id])).rows[0];
        assert.match(job.idempotency_key,/:automatic$/); assert.equal(job.payload.documentId,id);
        const run = await finished(id,job.id); assert.equal(run.provider,'local_qwen'); assert.ok(run.invoice);
        assert.equal((await r.query('SELECT processing_status FROM public.documents WHERE id=$1',[id])).rows[0].processing_status,'needs_review');
      } finally { await automatic.app.close(); await r.worker.documents.resume(); await consumer.resume(); }
    });

    it('enforces tenant boundaries, permissions, configuration and ambiguous-source review', async () => {
      const id = await document();
      for (const route of [`/v1/documents/${id}/extractions`, '/v1/providers/health']) assert.equal((await api.inject(route)).statusCode, 200);
      assert.equal((await api.inject({ url: `/v1/documents/${id}/extractions`, headers: { 'x-test-workspace':  r.otherWorkspace } })).statusCode, 404);
      assert.equal((await api.inject({ method: 'POST', url: `/v1/documents/${id}/extractions`, headers: { 'x-test-workspace':  r.readerWorkspace }, payload: {} })).statusCode, 403);
      assert.equal((await r.api.inject({ method: 'POST', url: `/v1/documents/${id}/extractions`, headers: { 'x-test-workspace':  r.workspace }, payload: {} })).statusCode, 503);
      const unknown = await document('business.pdf');
      assert.equal((await api.inject({ method: 'POST', url: `/v1/documents/${unknown}/extractions`, headers: { 'x-test-workspace':  r.workspace }, payload: {} })).statusCode, 409);
      assert.equal((await api.inject({ url: `/v1/documents/${id}/extractions?cursor=invalid`, headers: { 'x-test-workspace':  r.workspace } })).statusCode, 400);
      const foreign = await api.inject({ url: '/v1/providers/health', headers: { 'x-test-workspace':  r.otherWorkspace } });
      assert.deepEqual(foreign.json().providers, []);
    });
  });
}
