> Historical phase report: user sign-in and access tokens were subsequently removed. See [current local workspace behavior](local-workspace.md).

# Phase 9 — Backend API and workflow integration

Implemented on 2026-11-16. The completed components are integrated behind the canonical `/api/v1` API, with durable orchestration, manual correction, audit, recovery and polling. Existing `/v1` routes and the frontend overview remain available. No subsequent phase was started.

## Endpoints and access

| Endpoint | Behavior |
| --- | --- |
| `POST /api/v1/documents` | Existing signature-validated multi-file multipart upload, private MinIO storage and transactional ingestion intent. HTTP 202. |
| `GET /api/v1/documents` | Tenant-scoped metadata, status/batch filters and cursor pagination. |
| `GET /api/v1/documents/:id` | Metadata and original inspection. |
| `GET /api/v1/documents/:id/status` | Persisted stage progress/checkpoints, attempts, errors, grouped job counts and paginated job history. |
| `GET /api/v1/documents/:id/result` | Current invoice snapshots, original/current values, line items/evidence and normalized processing/understanding references. |
| `GET /api/v1/search` | Existing exact SQL, FTS, semantic and hybrid search, including supplier/date predicates. |
| `PATCH /api/v1/invoices/:id` | Optimistic invoice/line corrections, immutable originals, audited actor/time/reason and transactional follow-up intent. |
| `GET /api/v1/reviews` | Current invoices, uncertain candidates, unresolved current validation issues and failed jobs. |
| `POST /api/v1/jobs/:id/retry` | Durable, idempotent recovery of supported failed ingestion, extraction, indexing or workflow jobs. HTTP 202. |
| `GET /api/v1/reconciliations/:id` | Existing financial comparison, source evidence and currentness. |
| `GET /api/v1/invoices/:id/history` | Paginated immutable invoice and line-item audit events, with exact before/after JSON text. |
| `GET /api/openapi.json` | OpenAPI 3.1 documentation for the requested API and audit history, including schemas, bearer authentication and errors. |

Every business endpoint verifies signed issuer/audience/expiry claims and an active database tenant/user. Readers can read; reviewers/admins can upload, correct and retry. Tenant identity comes from verified claims. Existing forced RLS, tenant transactions and composite foreign keys remain in use. Foreign records return not-found outcomes. Routes validate UUIDs, query/body fields, pagination and supported correction fields through Zod. SQL values are parameterized; correction column names are explicitly allowlisted.

Legacy route handlers are reused through scoped registration aliases; upload validation/storage logic is not copied. New workflow handlers delegate to WorkflowRepository, which invokes existing financial, extraction and indexing services. Canonical responses rewrite Location headers to `/api/v1`. JSON/input errors have safe machine-readable codes; database/provider details and credentials are not returned.

## Orchestration and recovery

`WORKFLOW_ENABLED=true` is the default. Newly uploaded documents record their workflow enrollment in metadata. Successful ingestion/extraction transactions and invoice/line corrections insert idempotent `workflow` processing_jobs in the same PostgreSQL transaction. Migration 0012 adds triggers, a pending-work index and one bounded SECURITY DEFINER claim function; no new table, queue database or microservice is introduced.

The worker's PostgreSQL scheduler claims one active-tenant job with a 180-second lease and a 30-second heartbeat. Expired claims are recoverable. Coordination/deterministic validation run locally; existing document, extraction and indexing workers continue through BullMQ. Redis outages do not erase workflow or downstream dispatch intent.

The scheduler:

1. Reads the current normalized source/understanding and schedules eligible extraction using the existing privacy-enforcing provider abstraction.
2. Waits for the latest extraction attempt for each current candidate. Waiting does not consume the failure budget; actual failures do.
3. Revalidates current invoice snapshots using existing FinancialRepository rules, preserving the latest configured rules when available.
4. Recomputes existing reconciliation pairs involving the document. It does not guess unrelated matching documents.
5. Requests compatible indexing through IndexRepository and its existing transactional outbox. Partial/stale vectors stay hidden until complete publication.

Workflow failures use five attempts with exponential delays capped at 60 seconds; permanent input/source conflicts remain failed for review. Missing extraction configuration is explicit and retryable, rather than reported as successful extraction. Persisted progress includes waiting, financial validation, reconciliation and indexing dispatch. A successful workflow job means downstream intent was scheduled; inspect the separate indexing job to determine whether vectors are published.

Recovery serializes on the failed job. Same-key replays and simultaneous pending requests reuse a recovery job. A new ingestion attempt retains the verified storage reference and original failure; extraction recovery rechecks the active candidate; index recovery uses the current model/source space. Each downstream stage retains its bounded attempts/backoff. Successful jobs, unsupported job types and superseded ingestion sources cannot start another recovery. Same-key ingestion recovery still replays after its new execution succeeds. Original failures remain visible as history; job counts include historical attempts.

Previously uploaded documents are not silently enrolled/backfilled. A correction through the new endpoint enables transactional follow-up for that document. Disabling WORKFLOW_ENABLED pauses the scheduler; existing intent stays in PostgreSQL. The older EXTRACTION_AUTO_START option remains supported, while the integrated workflow flag controls the new whole-workflow path. Automatic extraction uses the existing stable scheduling key, so the two scheduling paths do not duplicate extraction jobs.

## Corrections and polling

Example header correction:

```json
{"revision":1,"changes":{"total":"120.00","customer_name":"Reviewed Buyer"},"reason":"Verified against the original invoice"}
```

Example line correction, using both current invoice and line revisions:

```json
{"revision":2,"line_items":[{"id":"LINE_UUID","revision":1,"changes":{"unit_price":"60.00"}}],"reason":"Reviewed line price"}
```

Supported header fields: invoice number/date, supplier/customer, subtotal/tax/total and currency. Supported line fields: description, quantity, unit price, tax rate and line total. Header and line changes can be combined atomically; up to 20 existing lines per request. Lines cannot be moved between invoices. A stale/missing line rejects the entire transaction. Source evidence/original values are not writable. Financial numbers are decimal strings or null; there is no JavaScript floating-point financial calculation. Currency uses three uppercase letters; rates use normalized fractions. Unknown/missing fields can remain null and are evaluated by deterministic rules.

Database triggers preserve original_values, increment revisions, record actor/time/before/after/reason and require human review after changes. An omitted reason is recorded as `Manual correction (no reason supplied)`. Parent and line corrections, audit events and workflow intent commit together. The search generation changes immediately, hiding stale chunks. Original normalized text remains separately indexed from current corrected facts after reindexing. Financial revalidation and reconciliation are asynchronous; approval is a separate human decision.

Poll status every two seconds. Responses contain `Retry-After: 2`, `Cache-Control: no-store`, `poll_after_ms: 2000`, `jobs.items`, `jobs.next_cursor` and `job_counts`. Progress reports real stages, not a fabricated percent-complete estimate. Polling satisfies this phase; SSE is not implemented.

Document lists retain existing `limit`/`cursor` and `nextCursor`. New result/review/history/status pages use limit/cursor and `next_cursor`; status nests its cursor under jobs. Limits are 1–100/default 25; results cap at 20 invoices, each using the existing 1,000-line bound. Cursors preserve PostgreSQL microseconds and UUID ordering. Ranked search uses its existing top-k limit (maximum 100), rather than cursor pagination. Empty results during processing do not imply successful invoice extraction. Original extraction proposals and detailed classification remain available through existing aliased extraction/understanding routes.

## Run and configure

From the repository root:

```bash
npm run setup:env
npm run infra:up
npm run db:migrate
npm run dev
```

The existing machine already has infrastructure and applications running; do not start duplicate processes on occupied ports. Migration 0012 is applied. Root ignored `.env` received WORKFLOW_ENABLED=true without replacing existing credentials or extraction/embedding model choices. Existing provider privacy rules still apply: cloud is disabled unless explicitly enabled and documents are approved. A functioning private local Qwen Instruct endpoint or approved Gemini configuration is required for real invoice extraction. The integration tests mock inference; they do not establish that an external provider/model is available.

Existing Python Work interpreter remains:

```text
/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python
```

The required shell inspection found no activated `python` alias; the exact existing interpreter was verified directly. No Python environment, dependency package or model asset was created/installed/downloaded in this phase. Existing dependencies were reused; package.json changes add a test command only.

Use a current token and real UUIDs:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
curl -F 'files=@invoice.pdf' http://127.0.0.1:3001/api/v1/documents -H "Authorization: Bearer $API_TOKEN"
curl http://127.0.0.1:3001/api/v1/documents/DOCUMENT_ID/status -H "Authorization: Bearer $API_TOKEN"
curl http://127.0.0.1:3001/api/v1/documents/DOCUMENT_ID/result -H "Authorization: Bearer $API_TOKEN"
curl -X PATCH http://127.0.0.1:3001/api/v1/invoices/INVOICE_ID \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"revision":1,"changes":{"total":"120.00"},"reason":"Verified total"}'
curl -X POST http://127.0.0.1:3001/api/v1/jobs/FAILED_JOB_ID/retry \
  -H "Authorization: Bearer $API_TOKEN" -H 'Idempotency-Key: recover-failed-001' \
  -H 'Content-Type: application/json' -d '{"reason":"Restored local dependency"}'
curl http://127.0.0.1:3001/api/openapi.json
```

The existing financial terms/validation, reconciliation creation, indexing, privacy, extraction and understanding endpoints also have `/api/v1` aliases. Their business contracts remain documented in earlier phase reports. Financial conventions must be explicitly confirmed before unknown adjustments/tax basis can pass deterministic checks. Existing embedding snapshots must be cached for semantic search/indexing.

## Verification

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Passed workspaces, scripts and tests |
| `npm test` / `npm run test:node` | 186 Node and 73 Python tests passed |
| `npm run test:workflow` | 58 ingestion/extraction/workflow API tests passed; includes 19 new workflow checks |
| `npm run test:database` | 47 passed, including full migration down/up |
| `npm run test:financial` | 20 passed |
| `npm run test:search` | 19 passed |
| `npm run build` | Packages, API, worker and Next.js production build passed |
| `npm run test:integration` | 8 live service/infrastructure checks passed |
| `npm run test:embeddings:live` | 3 real local Qwen/HTTP checks passed |
| `npm run db:status` | All 12 migrations applied |
| `npm audit --omit=dev` | 0 vulnerabilities |

Total: **414 passing automated tests**. The workflow command deliberately runs the complete existing ingestion/extraction suite and the registered workflow cases together, reusing its isolated infrastructure and fixtures. `test:ingestion` and `test:workflow` are the same suite, not two separately counted test sets.

Final checks found no leftover disposable test databases, queue keys or storage buckets. All 23 documented files exist without trailing whitespace. The live OpenAPI endpoint returned HTTP 200. No configured secret values were found in repository source; `.env` remains ignored with mode 0600, and model caches remain ignored. Synthetic fixtures from the interrupted test run were removed. The existing Python interpreter path was verified again.

Coverage includes every requested endpoint, all-endpoint authentication, tenant boundaries, reader restrictions, strict/malformed inputs, cursor pages, real PDF normalization, segmentation, source-grounded mocked extraction, deterministic validation, indexing/search, original/current preservation, invoice/line audit history, stale revisions and atomic line-conflict rollback, reconciliation refresh, every supported recovery type, stable replay after recovery, expired workflow leases and missing provider configuration. Inference is mocked in these orchestration tests; actual Qwen embedding checks are separate. No new real Gemini/Qwen Instruct quality evaluation was performed.

Python emits five existing PyMuPDF SWIG deprecation warnings. The deliberate interrupted-storage test emits the expected SDK warning. Existing application processes were preserved; the API's watched entry was touched to reload its new modules.

## Files created

- `packages/contracts/src/workflow.ts`
- `packages/database/src/workflow.ts`
- `packages/database/migrations/0012_workflow_integration.sql`
- `apps/api/src/workflow/routes.ts`
- `apps/api/src/workflow/openapi.ts`
- `apps/worker/src/workflow.ts`
- `tests/ingestion/workflow-cases.ts`
- `tests/unit/workflow.test.ts`
- `docs/phase-9-backend-integration.md`

## Files modified

- `.env.example`
- `package.json`
- `README.md`
- `packages/contracts/src/index.ts`
- `packages/core/src/env.ts`
- `packages/database/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/ingestion/routes.ts`
- `apps/api/src/ingestion/repository.ts`
- `apps/worker/src/app.ts`
- `tests/ingestion/ingestion.test.ts`
- `tests/search/search.test.ts`
- `docs/architecture.md`
- `docs/database-schema.md`

Local ignored `.env` received one missing default. The API entry file was touched only to reload the existing development watcher; its contents are unchanged. Build/cache/test outputs remain ignored. No secrets were committed.

## Operational boundaries and acceptance

Workflow coordination is intentionally one leased task at a time, with at most 100 current invoices and 50 existing reconciliation pairs per document; larger workloads fail explicitly for review. Results expose bounded invoice snapshots and artifact references rather than streaming all source pages in one HTTP response. Existing artifact retrieval remains internal/authenticated. Line corrections update existing rows; inserting/deleting invoice lines and the review UI are outside this phase. There is no guessed cross-document pairing, automatic human approval or fabricated extraction when a provider is unavailable.

Before rolling back 0012, stop writers/workflow execution and back up. Its Down SQL removes scheduling triggers/index/function and cancels unfinished workflow tasks while preserving completed/failed job history, corrections, invoices, source evidence and audit records. Reapplying does not reconstruct canceled intent; explicitly retry/reschedule as appropriate. Full down/up is tested in disposable PostgreSQL databases. Prefer forward migrations with real data.

Acceptance passed: all requested endpoints work; authentication/authorization, tenant access, validation, pagination, errors, persisted progress/polling, failed-job recovery, audited original-preserving manual correction, follow-up validation/indexing, search and reconciliation are integrated and tested. OpenAPI documentation is served. The existing Python environment is preserved. This phase stops here.
