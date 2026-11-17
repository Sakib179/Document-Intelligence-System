# AI-Powered Document Intelligence System

The system accepts validated multi-file uploads, stores private originals in MinIO, and dispatches recoverable BullMQ jobs. The Python engine extracts digital PDF text/tables, runs page-level OCR where needed, and reads every Excel worksheet and streaming CSV rows. The worker persists versioned source evidence, classifies documents and segments invoice candidates with deterministic rules. An extraction consumer uses Gemini for approved cloud data or a private local Qwen endpoint and saves evidence-grounded extraction history. A deterministic decimal engine validates financial calculations, flags duplicates and reconciles PDF/PDF or PDF/spreadsheet records without changing reported values. Unknown facts require review. Local Qwen embeddings and PostgreSQL provide exact, keyword, semantic and hybrid search through tenant-scoped REST APIs.

## Requirements

- Node.js 24 (verified with 24.18.0) and npm 11 (verified with 11.16.0).
- Docker Desktop running with Compose v2 or newer, internet access, and sufficient build memory.
- Tesseract system executable and English language data for OCR/tests; `osd` enables orientation detection. Bangla uses `ben` data when installed.
- The existing UV-managed **Python Work (.venv)** environment. Verified interpreter:
  `/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python` (Python 3.12.13).

Do not create, delete, replace, or synchronize a Python environment. In particular, do not use `uv venv`, `python -m venv`, `uv run`, or `uv sync` for this service. The launch script uses the exact configured interpreter without resolving its symlink to a system Python.

## First run

Run these commands from the repository root:

```bash
npm ci
npm run setup:env
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-test.txt
npm run infra:up
npm run db:setup
npm run dev
```

`setup:env` creates a root `.env` with random local credentials and mode `0600`. When configuration grows, it adds missing keys without replacing existing values or credentials. It is ignored by Git. `.env.example` contains placeholders only. Set `PYTHON_EXECUTABLE` to the existing interpreter if its location changes. No credentials are printed by setup.

`infra:up` builds MinIO, starts PostgreSQL/pgvector and Redis, waits for healthy containers, then creates the dedicated `documents` bucket and removes its anonymous-access policy. The first MinIO build downloads Go dependencies and can take several minutes. No host Go installation is required.

`db:setup` provisions restricted runtime/dispatcher logins, applies the twelve SQL migrations, and loads idempotent fictional development fixtures. Seed object references intentionally do not exist in MinIO and seed jobs are not dispatched. Use `db:migrate` when fixtures are not wanted. New uploads use the real storage/ingestion path; understanding candidates are created by actual processing rather than seeded as executed results.

`dev` builds shared packages and starts all four applications. Ctrl+C stops these application processes; Docker infrastructure remains running. Changes to a shared package require `npm run build:packages` or restarting `npm run dev`.

| Service | Address | Check |
| --- | --- | --- |
| Next.js | http://127.0.0.1:3000 | `/api/health` |
| Fastify API | http://127.0.0.1:3001 | `/health`, `/health/ready` |
| BullMQ worker | http://127.0.0.1:3002 | `/health`, `/health/ready` |
| Python processor | http://127.0.0.1:8000 | `/health`, `/health/ready` |
| MinIO S3 API | http://127.0.0.1:9000 | Authenticated S3 access |
| MinIO console | http://127.0.0.1:9001 | Credentials from root `.env` |
| PostgreSQL | 127.0.0.1:55432 | Password required; `vector` extension initialized |
| Redis | 127.0.0.1:6379 | Password required |

All application defaults and published infrastructure ports bind to loopback. Services are not exposed to the LAN. Health URLs intentionally return operational status without credentials or connection strings.

To inspect and stop infrastructure without deleting stored data:

```bash
npm run infra:status
npm run infra:down
```

The named PostgreSQL, Redis, and MinIO volumes persist across restarts. Do not delete volumes to resolve configuration errors. PostgreSQL initialization SQL only runs on a fresh volume. Changing passwords in `.env` does not rotate credentials inside an existing PostgreSQL volume.

## Existing Python environment

First inspect the editor's active interpreter with the required command:

```bash
python -c "import sys; print(sys.executable)"
```

In the inspected nonactivated shell, `python` was unavailable. The exact existing interpreter was located and verified directly:

```bash
"/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -c 'import sys; print(sys.executable); print(sys.version)'
```

FastAPI, Uvicorn, Pydantic, HTTPX, pytest, Pillow, multipart, NumPy and encoding detection were already present. Inspection dependencies and then pytesseract, headless OpenCV, openpyxl and boto3 were installed into that same environment. Target the existing interpreter explicitly:

```bash
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-test.txt
```

Review dependency changes before installing into this shared environment. The service's `pyproject.toml` configures pytest only; it does not define a new UV project or environment. Do not edit or synchronize the unrelated parent Python Work project.

Tesseract is separate from Python dependencies. On this machine `brew install tesseract` installed 5.5.4 with `eng` and `osd`. Bangla (`ben`) is currently missing. Inspect capabilities without starting a service:

```bash
npm run processor:doctor
tesseract --list-langs
```

Install the desired language data through your system package manager (Homebrew offers `tesseract-lang`, which installs additional languages). `OCR_LANGUAGES=eng+ben` uses installed requested languages and records missing-language warnings. An OCR page fails explicitly when Tesseract or all requested language packs are unavailable. Digital extraction remains usable. See the [processing report](docs/phase-4-document-processing.md) for configuration and limits.

## Development and production builds

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
npm run dev:processor
```

Run each command in a separate terminal when using individual services. All Node services load the root `.env` regardless of workspace working directory. The Python and web launchers do the same.

```bash
npm run typecheck
npm run build
npm start
```

After building, the independently executable applications can be started in separate terminals:

```bash
npm run start --workspace @doc/api
npm run start --workspace @doc/worker
npm run start --workspace @doc/web
npm run start:processor
```

Next.js 16 keeps development output in `.next/dev` and production output in `.next`, allowing these builds to coexist. Do not delete/move `.next` while a development server is running. Production commands here are local launch checks, not a production deployment.

## Verification

Unit and Python tests do not require Docker. Actual OCR tests require Tesseract with English data:

```bash
npm test
npm run evaluate:processor
```

With local PostgreSQL, Redis and MinIO running, database and ingestion tests create isolated resources and start their own temporary inspector/API/worker processes:

```bash
npm run test:database
npm run test:ingestion
npm run test:financial
npm run test:search
```

With infrastructure and all four applications running:

```bash
npm run test:integration
npm run test:embeddings:live
```

The database suite requires PostgreSQL and the configured migration administrator. It creates and removes an isolated database; it does not roll back or delete the development database. It tests the schema, tenant access, exact decimals, evidence, audit history, duplicates, vectors, transactions, seed idempotency, advisory locking, migration failure atomicity, and full down/up migrations.

The live checks cover authenticated PostgreSQL and vector operations, Redis read/write, authenticated MinIO upload/read/delete, denial of anonymous object access, API/worker/Python health, a real BullMQ job round trip, and Next.js rendering and health. Test objects and Redis keys are removed; the operational queue retains at most 100 completed and 100 failed probes. The failed-job retention is bounded separately for integration probe submissions.

Liveness (`/health`) reports a running HTTP process. Readiness (`/health/ready`) returns `503` when a required dependency is unavailable. API readiness checks PostgreSQL/pgvector, private storage, and the local inspector. Redis availability is a worker concern: durable uploads can still return 202 while it is unavailable. Worker readiness checks PostgreSQL, Redis, consumers, dispatcher and processor availability. Python provides health, authenticated inspection/processing, private artifact retrieval and capability reporting.

## Upload and document APIs

The API uses the configured local workspace directly; no sign-in or access token is required.

Then submit repeated `files` parts, using a new idempotency key for each intended batch:

```bash
curl -i http://127.0.0.1:3001/v1/upload-batches \
  -H "Idempotency-Key: my-first-invoice-upload" \
  -F "files=@/absolute/path/invoice.pdf;type=application/pdf" \
  -F "files=@/absolute/path/ledger.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

curl http://127.0.0.1:3001/v1/documents
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/status
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/understanding
```

Successful uploads return HTTP 202, a batch `Location`, document IDs and the effective idempotency key. The request is atomic for format validation: one invalid file rejects the batch. Same-key/same-payload retries reuse the batch/documents/jobs; changed payloads return 409. Separate intended duplicate uploads are stored and receive duplicate-content hints. No invoice duplicate detector runs yet.

Supported extensions: PDF, JPG/JPEG, PNG, TIF/TIFF, XLSX, XLS and CSV. Defaults are 10 files, 50 MiB/file, 100 MiB/batch and 1,000 logical pages/frames/worksheets per document, configurable in root `.env`. CSV is parsed as text because it has no binary signature. The [ingestion reference](docs/ingestion.md) details workspace scoping, limits, errors, retries, antivirus, storage recovery and API responses.

Antivirus is explicitly `disabled` locally and reported as `not_scanned`. Set `ANTIVIRUS_MODE=clamav` with a running private ClamD service to enable INSTREAM scanning; scanner errors fail closed. No claim is made that disabled scanning verifies a file is malware-free.

After processing, `/v1/documents/:id/understanding` returns the active versioned classification and invoice candidates, with `limit`/`cursor` pagination. Invoice, receipt, other business and unknown content retain page/worksheet/cell ranges, evidence and review reasons. Unknown/ambiguous pages remain separate; confirmed continuations can span pages. Several invoice candidates yield `invoice_bundle` in the document DTO when the document is consistently invoice content. The [understanding report](docs/phase-5-understanding.md) explains rules, API fields and limitations.

Cloud advice is off by default. Optional Gemini suggestions require the global `CLOUD_LLM_ENABLED=true` gate, `SEGMENTATION_AI_ENABLED=true`, configured Gemini extraction/advice models and API key, insufficient deterministic evidence and explicit document approval in PostgreSQL. Only bounded relevant excerpts are sent after a durable audit checkpoint. Advice remains a manual-review suggestion and does not automatically merge candidates or approve financial values. No live Gemini call was made during implementation.

```bash
npm run evaluate:segmentation
```

The command writes actual rule-engine results against labeled synthetic regression fixtures to `docs/evaluation/segmentation-synthetic.json`; those scores do not establish real-document accuracy.

## AI invoice extraction

Extraction is explicitly requested by default. Configure a running private Qwen Instruct server in root `.env` before requesting it:

```dotenv
CLOUD_LLM_ENABLED=false
GEMINI_MODEL=gemini-3.8-flash
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen3.5:4b
EXTRACTION_AUTO_START=false
```

The selected models are [Gemini 3.8 Flash](https://aistudio.google.com/docs/models/gemini-3.8-flash) and [Qwen 3.5 4B](https://ollama.com/library/qwen3.5:4b). Gemini segmentation advice uses the same Flash model. No model or inference runtime is installed automatically. With Ollama installed, run `ollama pull qwen3.5:4b` to install the selected local model and ensure the Ollama server is running. The local server must support OpenAI-compatible chat completions with JSON Schema output. Loopback hosts are allowed by default; a private LAN endpoint additionally needs an explicit `LOCAL_LLM_ALLOWED_HOSTS` entry. Public addresses, metadata endpoints and redirects are rejected. Keep this server private and ensure it actually runs inference locally. See [Ollama's protocol reference](https://docs.ollama.com/api/openai-compatibility).

Restart API/worker processes after configuration changes. After upload normalization and segmentation finish:

```bash
curl -i -X POST http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/extractions \
  -H "Idempotency-Key: invoice-extraction-001" \
  -H "Content-Type: application/json" -d '{}'
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/extractions
curl http://127.0.0.1:3001/v1/providers/health
```

POST returns 202 with durable job IDs. Reusing a key returns the same jobs, including failed jobs. Use a new key for an intentional new extraction or recovery; earlier results and manual corrections are preserved. Candidate boundary conflicts return 409; missing provider configuration returns 503. Set `EXTRACTION_AUTO_START=true` to schedule eligible candidates in the same transaction that publishes understanding results for new uploads.

For Gemini, configure `GEMINI_API_KEY`, an account-supported structured-output `GEMINI_MODEL`, and `CLOUD_LLM_ENABLED=true`. An active tenant administrator must classify each source as public/synthetic or explicitly approve a confidential source through `PATCH /v1/documents/:id/privacy`. A filename or AI classification never grants cloud permission. The fictional tenant A development user is an admin; real tenant provisioning remains an administrative responsibility. Policy is checked before every request/retry. A configured private local provider handles eligible Gemini failures; private documents use it directly.

Each field includes a nullable value, original `raw_value` and page/worksheet/cell evidence. Provider proposals and grounded results remain separate. Unsupported values are nulled and flagged. All new invoices require review, and no LLM or grounding code calculates or approves financial totals. Timeouts, bounded retries, provider health/circuits and failed jobs are persisted. The [phase 6 report](docs/phase-6-ai-extraction.md) includes the privacy endpoint example, limits, complete file inventory and actual mocked-provider verification. Live model accuracy has not been evaluated.

## Financial validation and reconciliation

The `@doc/finance` workspace uses decimal.js for all monetary arithmetic. It checks mandatory fields, numeric formats/signs/quantities, line products, subtotals, tax where its scope is explicit, and reported totals with charges, discounts and withholding. Configurable rules support tax-inclusive/exclusive/exempt treatment, currency minor units, rounding tolerances and signed records. Exact file duplicates and business duplicate candidates are flagged for review without rejecting or merging invoices.

Financial requests are explicit, synchronous, bounded transactions. They do not call an LLM. Processing completion, manual approval and financial status remain separate. Outcomes are `VALID`, `WARNING` or `REVIEW_REQUIRED`, stored as immutable snapshots. New source corrections or duplicate context make an older validation stale. Reconciliation keeps both original/current values and page/worksheet/cell evidence; ambiguous matches remain review items. PDF-to-spreadsheet comparison supports XLSX, XLS and CSV invoice records already extracted by earlier phases.

Read an invoice and its current revision, then request validation:

```bash
curl http://127.0.0.1:3001/v1/invoices/INVOICE_ID/validations
curl -X POST http://127.0.0.1:3001/v1/invoices/INVOICE_ID/validations \
  -H "Idempotency-Key: financial-check-001" \
  -H "Content-Type: application/json" -d '{}'

curl -X POST http://127.0.0.1:3001/v1/reconciliations \
  -H "Idempotency-Key: reconcile-001" \
  -H "Content-Type: application/json" \
  -d '{"left_document_id":"PDF_DOCUMENT_ID","right_document_id":"OTHER_DOCUMENT_ID"}'
curl http://127.0.0.1:3001/v1/reconciliations/RUN_ID
```

Replace IDs with actual UUIDs. POST returns 201 for a new snapshot and 200 for a same-key replay. Changed rules/sources under the same key return 409; use a new key for intentional reruns. Source changes preserve the old report and set `is_current=false` when it is read again. Financial status returned by the invoice history API becomes `REVIEW_REQUIRED` for a stale latest result.

The extraction schema does not establish charges, discounts, withholding, full line coverage or tax basis. Unknown terms therefore produce review issues. An authorized reviewer can confirm them through `PATCH /v1/invoices/:id/financial-terms`, using the current revision, explicit terms and a reason. Missing adjustments are never silently replaced with zero. The [phase 7 report](docs/phase-7-financial-validation.md) documents the full terms request, rule configuration, tax formulas, API behavior, file inventory, verified tests and limits.

## Next.js document workspace

Open http://127.0.0.1:3000. The seven screens use the actual backend: dashboard, multi-file upload, document library/details, manual review, search and reconciliation. Service status remains available at `/system`.

The dashboard opens directly without sign-in. `LOCAL_WORKSPACE_TENANT_ID` and `LOCAL_WORKSPACE_USER_ID` select an existing active tenant and operator on the server. Defaults match development seed data (`npm run db:seed`). All visitors share that operator and its permissions; audit entries identify the configured operator, not individual visitors. Client headers cannot select another tenant. Keep the existing loopback defaults for local use. Database, private storage and internal processor credentials remain necessary.

```bash
npm run dev
# In a separate terminal, with PostgreSQL/Redis/MinIO available:
npm run test:frontend
```

Do not start duplicate services if the existing development processes are running. The browser suite starts isolated API/Next.js/worker processes with disposable database/storage/queue resources. It uses installed Chrome through pinned Playwright Core. On another machine set `CHROME_EXECUTABLE` to an existing compatible Chrome/Chromium binary. No browser or AI model download is performed by these tests.

Uploads show actual transferred bytes followed by server acceptance and live processing status. Details pair a private PNG rendering of the original page/frame with source text/cells, OCR information, invoice fields, validation issues and provider/model metadata. Spreadsheet previews use original normalized cells and cached values; formulas/macros are not executed. Manual corrections retain original values and audit history. Search supports keyword, semantic, hybrid and precise invoice/currency/amount filters. Comparisons show both source values and highlight discrepancies.

All source/document previews are authenticated and streamed through the web server; MinIO stays private. Existing fictional seed rows may have no original object, which is shown as unavailable. Real extraction still requires the existing approved Gemini or private Qwen configuration, and semantic search needs the already configured local embedding assets. The [phase 10 report](docs/phase-10-frontend.md) records files, exact commands, tests and limits.

## Integrated backend API

Use `/api/v1` for new clients. Existing `/v1` routes remain compatible. `POST /api/v1/documents` accepts the same repeated multipart `files` parts as the original upload route. All business endpoints use the configured local workspace and restricted PostgreSQL roles. OpenAPI 3.1 documentation is available at [http://127.0.0.1:3001/api/openapi.json](http://127.0.0.1:3001/api/openapi.json).

With `WORKFLOW_ENABLED=true` (default), new uploads persist workflow intent. After normalization and segmentation, the worker schedules permitted extraction, deterministic financial validation and indexing. Correction events schedule revalidation, refresh existing reconciliation pairs and update the search index. The PostgreSQL workflow scheduler uses leased, bounded jobs; document, extraction and indexing work continues through the existing BullMQ queues. Provider cloud approval remains mandatory. Unavailable providers produce durable failures instead of invented invoice values.

```bash
npm run setup:env
npm run db:migrate
npm run dev
# Complete upload/extraction/workflow API integration suite:
npm run test:workflow
```

Use a real document UUID and current invoice revision:

```bash
curl -F 'files=@invoice.pdf' http://127.0.0.1:3001/api/v1/documents
curl http://127.0.0.1:3001/api/v1/documents/DOCUMENT_ID/status
curl http://127.0.0.1:3001/api/v1/documents/DOCUMENT_ID/result
curl -X PATCH http://127.0.0.1:3001/api/v1/invoices/INVOICE_ID \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"changes":{"total":"120.00"},"reason":"Checked against the original invoice"}'
curl http://127.0.0.1:3001/api/v1/invoices/INVOICE_ID/history
curl http://127.0.0.1:3001/api/v1/reviews
curl -X POST http://127.0.0.1:3001/api/v1/jobs/FAILED_JOB_ID/retry \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: recover-job-001' -d '{"reason":"Restored local inference service"}'
```

Poll status every two seconds. Its paginated `jobs.items` exposes persisted progress/checkpoints, stage counts and errors; document processing status remains separate from financial status. Results return current invoice snapshots with original/current values and source evidence. Corrections require reviewer/admin permissions and optimistic revisions. Database audit records identify the actor, time and supplied reason; omitted reasons receive an explicit marker. Recovery retains the original failed job and schedules a new bounded execution.

List/status/result/review/history routes support bounded pagination. Document lists retain `nextCursor`; workflow pages use `next_cursor` (status under `jobs`). Ranked search uses a top-k `limit`. See [phase 9](docs/phase-9-backend-integration.md) for all endpoints, request shapes, files, configuration, actual verification and operational limits. The authenticated Next.js workspace now integrates these workflows; see the phase 10 report.

## Local embeddings and search

Qwen3-Embedding-0.6B is the one active embedding model. It is separate from the local Qwen Instruct extraction model. Both embedding candidates were downloaded to ignored local cache for the requested benchmark; Harrier runs only in a separate benchmark process. Inference never downloads assets or sends document/query text to a cloud service.

From the repository root, install missing embedding dependencies into the existing interpreter only, cache the pinned Qwen snapshot explicitly, then run migrations and applications:

```bash
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-embeddings.txt
npm run setup:env
npm run embeddings:download -- --model qwen
npm run db:migrate
npm run dev
```

All embedding dependencies and the Qwen snapshot are already present on the verified machine. Default settings are `EMBEDDINGS_ENABLED=true`, `EMBEDDING_DIMENSIONS=1024`, `CHUNK_TARGET_TOKENS=450` and `CHUNK_MAX_TOKENS=600`. Root `.env.example` lists the pinned model revision, query instruction, local cache and timeout settings. Model loading is lazy; missing local assets return a service error. API/worker/Python must share model settings. Restart these processes after configuration changes.

Index a normalized document in the configured local workspace. With WORKFLOW_ENABLED=true, new uploads automatically schedule extraction, validation and indexing; the explicit indexing endpoint also remains available. Keep the same key for request replay, or use a new key and `{"reindex":true}` for a fresh run:

```bash
curl -X POST http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/index \
  -H "Idempotency-Key: search-index-001" \
  -H "Content-Type: application/json" -d '{}'
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/index
curl --get http://127.0.0.1:3001/v1/search \
  --data-urlencode 'mode=hybrid' --data-urlencode 'q=ঢাকার সৌর প্যানেলের চালান'
curl --get http://127.0.0.1:3001/v1/search \
  --data-urlencode 'mode=exact' --data-urlencode 'invoice_number=INV-101'
```

Replace `DOCUMENT_ID` with a real UUID. Keyword/semantic/hybrid modes require `q`; all modes accept `supplier`, `date_from`, `date_to`, `invoice_number` and `limit`. Exact invoice lookup reads SQL records without loading an embedding model. Full-text search uses PostgreSQL's `simple` configuration, with no Bengali stemmer. Semantic/hybrid requests report an unavailable embedding service explicitly. Readers may search; reviewers/admins may request indexing.

Search exposes only complete published indexes matching the current source generation and embedding space. Corrections invalidate an old index; explicitly reindex to publish current values. Original source text and current invoice/line facts remain separate sections. Historical chunks remain immutable. Changing model, revision, prompt or chunking configuration requires reindexing; equal dimensions do not make two model spaces compatible. The application schema is deliberately `vector(1024)`; other database dimensions require a migration.

Run both model benchmarks on the same labeled synthetic English/Bengali dataset:

```bash
npm run embeddings:download -- --model harrier
npm run benchmark:embeddings
# Individual experiments do not change the production model:
npm run benchmark:embeddings -- --harrier-only
npm run test:search
npm run test:embeddings:live
```

The measured 30-document/16-query run produced Qwen Recall@10 **0.9792** and Harrier **0.9167**. The [saved comparison](docs/evaluation/embeddings-comparison.json) includes all retrieval metrics, inference/search timings, peak process RAM and HNSW plans. This small synthetic dataset is a reproducible smoke benchmark, not a production accuracy claim. The [phase 8 report](docs/phase-8-local-search.md) contains API/configuration details, file inventory, rollback behavior, actual tests and limitations.

## Layout and boundaries

```text
apps/api/                      Fastify API process
apps/worker/                   BullMQ consumer and health process
apps/web/                      Authenticated Next.js document workspace and server proxy
packages/contracts/            Shared Zod schemas and types
packages/core/                 Configuration, health, connectors, shutdown
packages/finance/              Pure decimal validation, duplicate signals and reconciliation
packages/database/             SQL schema/migrations, tenant transactions, runtime/admin pools, seed data
services/document-processor/   Python FastAPI service and tests
infra/                        Local Compose, pgvector initialization, MinIO build
scripts/                      Environment setup, launchers, infrastructure verification
tests/                        Cross-package unit tests
docs/                         Foundation decisions and verification report
```

PostgreSQL is the source of truth for document metadata, source evidence, invoices, durable jobs, review history, validation/reconciliation records, indexing runs and search chunks. Redis carries compact document/extraction/indexing jobs and operational probes. Document, extraction and indexing queues have consumers. OCR runs inside the Python document engine; the other stage queues are reserved. New uploads reach `processed`, `partially_processed` or `failed` after source extraction. Here `processed` means normalization finished; it does not mean financial validation finished. AI extraction produces `needs_review` records. Earlier records are preserved without automatic backfill. The Next.js workspace uses workspace-scoped REST APIs for document upload, review, search and reconciliation.

## Database operations

```bash
npm run db:setup
npm run db:status
npm run db:migrate
npm run db:seed
```

Runtime connections use `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD`, a nonowner role with forced row-level security. `POSTGRES_DISPATCHER_PASSWORD` belongs to a separate login permitted only to call leased outbox functions, not read business tables. `POSTGRES_USER`/`POSTGRES_PASSWORD` are reserved for migration/provisioning commands. Business queries use validated tenant transactions. An unscoped application query cannot see tenant rows. Manual financial corrections and issue resolutions require an active actor/reason and preserve originals/history.

Migration files have explicit Up/Down sections. Rollbacks require the current version and can be checked without committing changes:

```bash
npm run db:rollback -- --version 0012 --dry-run
```

The corresponding non-dry-run command reverts the latest migration; schema-table rollback can delete data and requires a backup. Reapplying SQL does not restore deleted records. Prefer forward migrations once real data exists. Read the [schema and rollback reference](docs/database-schema.md) before a downgrade.

## Local infrastructure decisions

- PostgreSQL: `pgvector/pgvector:0.8.7-pg17-bookworm`, pinned by image digest.
- Redis: `redis:8.2.11-alpine3.22`, pinned by image digest; AOF enabled, `noeviction`, password required.
- MinIO: built from official upstream commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`, tag `RELEASE.2025-10-15T17-29-55Z`, using pinned Go and Alpine base images.

The MinIO community repository is archived and its original public release images were unavailable during setup. This repository builds official source rather than relying on an unverified image mirror. See [upstream MinIO](https://github.com/minio/minio) and [the pinned release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). The upstream license is included in the container. APK dependencies are resolved from the pinned Alpine release's repositories; this is not a fully reproducible supply-chain build.

Local applications use restricted PostgreSQL logins, a server-configured workspace operator, an internal inspector token and dedicated MinIO root credentials. Public identity-provider enrollment, least-privilege object-storage identities, TLS and public deployment remain future work. For deployment, supply migration credentials only to administrative jobs; the shared local `.env` is not a production secret-isolation mechanism. Keep this setup on loopback; no cloud processing is configured.

If a port is occupied, update its root `.env` value. For MinIO, update `S3_ENDPOINT` together with `MINIO_API_PORT`. Persisted data, credentials, and compiled/build output remain untracked. Results and file inventories are recorded in the [foundation report](docs/phase-1-foundation.md), [initial-schema report](docs/phase-2-database.md), [ingestion report](docs/phase-3-ingestion.md), [document-processing report](docs/phase-4-document-processing.md), [understanding report](docs/phase-5-understanding.md) and [AI extraction report](docs/phase-6-ai-extraction.md). Reproducible, explicitly synthetic OCR measurements are in [the OCR evaluation JSON](docs/evaluation/processing-synthetic.json).
