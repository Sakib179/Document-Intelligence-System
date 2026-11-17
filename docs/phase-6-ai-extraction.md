# Phase 6: AI invoice extraction

Implemented on 2026-11-16. This phase consumes immutable normalized evidence and invoice candidates from earlier phases. It implements provider-independent extraction, evidence checks, privacy authorization, durable orchestration, result APIs and mocked-provider tests. Financial calculation validation, invoice reconciliation, embedding inference and extraction UI are outside this phase.

## Implemented behavior

The worker's InvoiceProvider interface supports the official Google Gen AI SDK (`@google/genai` 3.3.0) and a configurable private OpenAI-compatible local Qwen endpoint. Gemini is preferred when the global switch and the document policy permit it. Private documents use local Qwen directly. No LangChain, inference runtime or model weights were installed.

Shared Zod contracts define invoice number/date, supplier/customer names, subtotal/tax/total/currency and line items. Every field is `{value,raw_value,evidence}`; missing fields use null values. Evidence contains source_id, page, verbatim text and nullable worksheet/cell coordinates. Amounts are decimal strings. A versioned system prompt treats document text/context as untrusted, prohibits document instructions/tool use/code/SQL execution, and prohibits calculating or approving financial totals.

The worker selects relevant source excerpts from the candidate's immutable source version in PostgreSQL. It processes source pages independently and bounds context by 32,000 characters and 800 source units by default. Spreadsheet queries restrict evidence to candidate rows and recognized table headers. Header-row coordinates are preserved by segmentation, so another invoice record is not included merely to provide column context. Formula expressions are never sent for evaluation; existing cached values may be used with a warning.

After JSON/Zod validation, deterministic checks verify source IDs, exact page/worksheet/cell references, quotes, original values and explicit financial labels. Unsupported proposals are retained in `proposed`, nulled in `grounded` and flagged with validation issues. Dates and currency identifiers must be unambiguous. Bare dollar/pound/yen/rupee symbols do not establish a currency. Exact decimal normalization and explicit percentage-to-fraction conversion use decimal.js; no invoice amounts are added, multiplied or approved. Source extraction remains unchanged.

Every new invoice is `needs_review`, with `financially_validated:false` metadata. Run results are immutable snapshots. A later extraction creates another invoice snapshot and never updates an earlier invoice or its manually corrected values. Existing database triggers preserve originals and audited corrections.

## Privacy

Root configuration defaults to `CLOUD_LLM_ENABLED=false`. Documents default to a separate privacy classification of `confidential`; this is independent of the AI document_type such as invoice or receipt.

Gemini needs the global switch plus either:

- An administrator-stamped `public` or `synthetic` classification.
- Explicit administrator approval for cloud processing, including a confidential source.

Only an active same-tenant administrator can change that policy. HTTP authorization and a PostgreSQL trigger enforce the rule; the database supplies actor/time stamps and audits the reason. A file name, model proposal or client-supplied approval stamp cannot grant permission. The fictional development tenant A user is already an admin; production tenant administrators must be provisioned through trusted administration.

Policy is rechecked before every Gemini request/retry, including inside the durable pre-request transaction. Each attempt records its policy snapshot before network dispatch. Revocation affects subsequent dispatch decisions; it cannot recall a request already sent. Only bounded text evidence is submitted, without original files, S3 credentials or presigned links. The separate segmentation advisor now also requires the global cloud switch in addition to its existing flag and explicit approval.

The local transport requires an explicitly allowed host resolving only to loopback, RFC1918 or IPv6 unique-local addresses. It rejects public/link-local metadata addresses, URL credentials/query/fragment, redirects and cloud model tags. DNS resolution is checked and pinned to the actual connection. Node's private HTTP transport does not inherit external proxy routing. A trusted private server operator must ensure the endpoint performs inference locally rather than proxying it to a cloud provider. Public authenticated inference gateways are intentionally unsupported.

Protocol references: [Google structured output](https://aistudio.google.com/docs/structured-output), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility). Runtime code is checked against the installed SDK and controlled HTTP transports; these references do not constitute live model verification.

## Durable workflow and failures

Explicit extraction requests create candidate-bound processing_jobs with stable IDs in the same PostgreSQL transaction as the outbox intent. Optional `EXTRACTION_AUTO_START=true` schedules eligible candidates in the understanding publication transaction. It is false by default. Unknown, noninvoice and boundary-conflicted candidates cannot be extracted automatically or bypassed through the extraction API.

The existing leased dispatcher publishes compact references to extraction-queue. Payloads contain job/tenant/document/candidate/understanding-run IDs, never source files or text. A schema trigger validates those identities. PostgreSQL remains authoritative when Redis loses a job or publication acknowledgement. The worker fences execution with leases and checks the active understanding version before publishing results.

Before each actual provider request, extraction_attempts is committed. Completion records provider/model/version, prompt version, input digest, policy, schema outcome, duration, usage, fallback flag and safe error code. Sensitive response bodies, credentials and upstream error messages are not logged. Model version is null when the endpoint does not report one and no operator version is configured; it is never invented.

Each provider gets at most three requests, with an enforced timeout and exponential backoff. HTTP 429, server/connection failures and timeouts are transient. Local Retry-After is honored within the retry budget; longer delays skip another immediate retry and permit fallback. Authentication/model availability, malformed JSON/schema and truncated output can trigger local fallback without endless primary retries. Refusals are terminal. Evidence/business uncertainty produces nullable review values without switching providers. Failures to persist a request/response do not masquerade as provider failures and do not immediately trigger another paid call.

Tenant/model/endpoint protocol health persists in llm_provider_health. Consecutive failures open a bounded circuit; open circuits skip network requests and retain a failed attempt event. Success resets protocol failures even if business values need review. Health is observational, not an active paid model probe.

When both providers fail, the run and authoritative job become failed with their error/attempt history; no invoice is created. The API exposes these failures. A repeated idempotency key returns that same job; a new key intentionally requests recovery as a new snapshot. Job-level crash/infrastructure recovery is separately bounded to two executions. A process crash after a request was sent can cause another request on recovery; the system does not claim exactly-once external inference billing.

Migration 0007 adds the policy fields, candidate links, extraction_attempts and llm_provider_health with forced tenant RLS, identity constraints, audit triggers and indexes. It extends the existing privileged dispatcher functions without granting business-table access. The development database now has all seven migrations applied. Original migrations 0001–0006 were preserved.

For rollback, stop writers and export extraction/privacy/attempt history first:

```bash
npm run db:rollback -- --version 0007 --dry-run
```

The actual downgrade cancels unfinished extraction jobs/runs, restores ingestion-only dispatch, and removes the new attempt/health/privacy/link fields. Invoices, structured extraction results, original evidence and audit events remain. Reapplying does not reconstruct removed links or consent history; new classification fields default to confidential. Tests exercise cancellation, source preservation and a complete seven-migration down/up round trip only in disposable databases.

## Run and configure

From the repository root:

```bash
npm ci
npm run setup:env
npm run infra:up
npm run db:migrate
npm run dev
```

This phase needs no Python installation. The exact existing interpreter remains `/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python`, Python 3.12.13. The shell's `python` alias remains unavailable; the launcher uses the verified path. No environment was created, replaced, deleted or synchronized.

Configure a locally running Qwen Instruct model yourself. The endpoint must support `/v1/chat/completions`, nonstreaming responses and JSON Schema response_format. No Ollama executable/model was available during implementation, and none was downloaded.

```dotenv
CLOUD_LLM_ENABLED=false
GEMINI_MODEL=gemini-3.8-flash
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen3.5:4b
LOCAL_LLM_MODEL_VERSION=
EXTRACTION_AUTO_START=false
```

The user-selected models are [Gemini 3.8 Flash](https://aistudio.google.com/docs/models/gemini-3.8-flash), ID gemini-3.8-flash, and [Qwen 3.5 4B](https://ollama.com/library/qwen3.5:4b), Ollama ID qwen3.5:4b. Both root .env and .env.example select these IDs; Gemini segmentation advice uses the same Flash model. Cloud remains disabled by default. With Ollama installed, `ollama pull qwen3.5:4b` installs the selected model; the Ollama server must be running before local extraction. This configuration update did not install or run a model. Optionally set LOCAL_LLM_MODEL_VERSION to the deployed revision/digest when the server does not report a version. Keep API/worker configuration consistent and restart those processes after changes. At phase verification both providers were unconfigured; extraction returned 503. The selected local endpoint now permits scheduling, with an unavailable local model/server producing a durable failed run rather than fabricated output.

For optional Gemini processing, supply your own GEMINI_API_KEY and an account-supported structured-output GEMINI_MODEL, set CLOUD_LLM_ENABLED=true, and grant document-specific policy through an administrator. No paid call or key validation was performed. If Gemini is the only configured provider, confidential unapproved jobs fail visibly with no allowed provider. Configure local Qwen for private operation and fallback.

| Configuration | Default |
| --- | --- |
| CLOUD_LLM_ENABLED | false |
| GEMINI_API_KEY | empty |
| GEMINI_MODEL / GEMINI_SEGMENTATION_MODEL | gemini-3.8-flash |
| LOCAL_LLM_BASE_URL | http://127.0.0.1:11434/v1 |
| LOCAL_LLM_MODEL | qwen3.5:4b |
| LOCAL_LLM_MODEL_VERSION | empty |
| LOCAL_LLM_ALLOWED_HOSTS | localhost,127.0.0.1,::1 |
| EXTRACTION_AUTO_START | false |
| LLM_TIMEOUT_MS | 60000 |
| LLM_MAX_ATTEMPTS | 3, maximum 3 |
| LLM_RETRY_BASE_MS / LLM_RETRY_MAX_MS | 500 / 5000 |
| LLM_CIRCUIT_FAILURES / LLM_CIRCUIT_SECONDS | 3 / 30 |
| EXTRACTION_MAX_CONTEXT_CHARS | 32000 |

## APIs

Use the existing local development token command after loading fictional seeds if needed:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
```

Replace DOCUMENT_ID with an uploaded, normalized, segmented document UUID. Tokens are credentials; do not commit them or copy them into shared logs.

```bash
curl -i -X POST http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/extractions \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: invoice-extraction-001" \
  -H "Content-Type: application/json" -d '{}'

curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/extractions \
  -H "Authorization: Bearer $API_TOKEN"

curl http://127.0.0.1:3001/v1/providers/health -H "Authorization: Bearer $API_TOKEN"
```

POST accepts optional candidate_id and returns 202, effective idempotency key, job/candidate IDs and Location. Key reuse is scoped per candidate. Missing understanding/provider configuration or ambiguous boundaries return explicit errors. Readers can view results but cannot initiate extraction. All routes enforce the authenticated tenant.

GET supports limit 1–20, default 10, and opaque cursor pagination of runs; jobs lists up to 100 most recent extraction jobs. Results include proposed/grounded values, review issues, attempt metadata, exact decimal-string current/original invoice values and line items. Provider health returns tenant-observed protocol state and the cloud-enabled/local-configured flags, without secrets or endpoint URLs.

An administrator may classify an actually synthetic source for optional cloud processing:

```bash
curl -X PATCH http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/privacy \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"data_classification":"synthetic","cloud_processing_allowed":false,"reason":"Verified synthetic test invoice created for evaluation"}'
```

A public/synthetic classification itself permits cloud processing when the global switch is on. For a confidential document, keep classification confidential and set cloud_processing_allowed=true only after actual approval. To prohibit cloud processing again, use confidential with cloud_processing_allowed=false. The endpoint returns database-stamped policy metadata and whether Gemini is currently permitted.

## Actual verification

| Command | Observed result |
| --- | --- |
| npm run typecheck | Passed, including all test/tool TypeScript |
| npm test | 108 Node tests and 60 Python tests passed |
| npm run test:database | 47 passed in an isolated PostgreSQL database |
| npm run test:ingestion | 39 passed, including 11 mocked-provider extraction integration cases |
| npm run build | API, worker and production Next.js build passed |
| npm start, then npm run test:integration | 8 live checks passed; temporary applications stopped afterwards |
| npm audit --omit=dev --audit-level=moderate | 0 reported vulnerabilities |
| npm run db:migrate / db:status | 0007 applied; all seven versions applied |
| npm run infra:status | PostgreSQL, Redis and MinIO healthy; ports remain on loopback |

Total passing tests across those suites: **262**, with no skipped tests. Python emitted five pre-existing PyMuPDF/SWIG deprecation warnings. The intentional storage-disconnection test emits an AWS streaming error message while its recovery assertions pass.

A final scan of all 140 Git-visible source files found no configured-secret leaks or trailing whitespace. The ignored .env remains mode 0600. Cleanup inspection found zero disposable test databases, test buckets or test queue keys; temporary application listeners were stopped. Local infrastructure remains healthy.

Provider unit tests exercise the actual official SDK with an injected fetch transport and actual loopback HTTP for local protocol/security behavior. Integration tests use real PostgreSQL, Redis, BullMQ, MinIO, uploads, Python normalization, segmentation, APIs and extraction workers; Gemini transport and Qwen responses are controlled synthetic fixtures. Cases cover privacy/global gates, administrator enforcement/auditing, cloud primary, confidential explicit approval, private local operation, exact spreadsheet coordinates and candidate isolation, rate limits/retries/circuit state, schema fallback, business uncertainty without fallback, both-provider failure/recovery, key idempotency, immutable attempts, manual correction preservation, refusal, automatic scheduling and tenant/permission/configuration errors. Existing normalization tests cover all supported file formats.

These are implementation/protocol regression results. They are not model-quality evaluation metrics. No actual Gemini or Qwen accuracy, latency, cost, real-document precision/recall or hallucination rate has been measured in this phase. No cloud document submission occurred.

## Files and dependencies

Created:

```text
packages/contracts/src/extraction.ts
packages/database/src/extraction.ts
packages/database/migrations/0007_ai_extraction.sql
apps/api/src/ingestion/extraction.ts
apps/worker/src/extraction/types.ts
apps/worker/src/extraction/prompt.ts
apps/worker/src/extraction/local-transport.ts
apps/worker/src/extraction/providers.ts
apps/worker/src/extraction/grounding.ts
apps/worker/src/extraction/engine.ts
apps/worker/src/extraction/context.ts
apps/worker/src/extraction/repository.ts
apps/worker/src/extraction/processor.ts
tests/fixtures/extraction.ts
tests/unit/extraction.test.ts
tests/unit/extraction-providers.test.ts
tests/ingestion/extraction-cases.ts
docs/phase-6-ai-extraction.md
```

Modified:

```text
.env.example
README.md
package-lock.json
apps/api/src/ingestion/routes.ts
apps/worker/package.json
apps/worker/src/app.ts
apps/worker/src/ingestion.ts
apps/worker/src/outbox.ts
apps/worker/src/understanding/advisor.ts
apps/worker/src/understanding/engine.ts
packages/contracts/src/index.ts
packages/contracts/src/understanding.ts
packages/core/src/env.ts
packages/database/package.json
packages/database/src/index.ts
services/document-processor/tests/create_understanding_fixtures.py
tests/database/schema.test.ts
tests/ingestion/ingestion.test.ts
docs/architecture.md
docs/database-schema.md
```

The ignored root .env received 14 missing defaults through the existing setup helper; existing values/secrets were preserved. It remains mode 0600 and ignored by Git. Build output is ignored. No secrets were committed. No commit, push or deployment was performed.

Installed dependency: **decimal.js 10.6.0**, pinned in the worker and lockfile for exact source normalization. The database package also declares the existing local @doc/contracts 0.1.0 workspace dependency. The already-installed official @google/genai 3.3.0 SDK is reused. No Python, system package, inference runtime or model dependency was installed during this phase.

## Limits and acceptance

- Configure your real private inference server/model and optional cloud key/model before live extraction. Neither provider was available for live inference verification. Private gateways needing an authorization header are not currently supported.
- Context is bounded by configured character budget, 800 units, 1,000 characters per quote/source unit, 500 worksheet rows per source range and 1,000 queried cells. Truncation warnings survive in the result. The model response supports up to 200 line items and 8,192 output tokens; very large invoices require review or a later chunked extraction strategy. Missing model output cannot be inferred as complete coverage.
- Grounding checks source support, not semantic correctness or resistance to every prompt injection. All invoices require review. Prompts and transport expose no executable tools, and outputs are parsed only as data.
- Some valid regional number/date/currency forms are deliberately left uncertain. Bangla OCR still requires the existing missing ben language pack; no language/model download occurred here. Cached spreadsheet formula values can be stale and are flagged; formulas are never calculated.
- Health describes observed protocol behavior, not model accuracy or readiness to infer. Circuit counters are tenant/model/endpoint-scoped, not a global API-account quota coordinator. The Gemini SDK supplies HTTP status classification; Retry-After header parsing is provided by the local HTTP adapter.
- New manual extraction keys intentionally create snapshots, including repeated invoice identifiers. No invoice duplicate detector, financial validator, reconciler, review/correction UI or embedding inference is claimed complete.

Phase acceptance **passed for the requested implementation and mocked-provider unit/integration verification**. Cloud remains off by default, Python Work is preserved, failed jobs remain durable and no secrets are committed. Live model quality evaluation remains explicitly unperformed. Stop after this phase.
