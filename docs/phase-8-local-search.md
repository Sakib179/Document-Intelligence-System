# Phase 8 — Local embeddings, pgvector and search

Completed and verified on 2026-11-16. This phase adds working local embedding inference, durable indexing/reindexing, tenant-scoped search and an actual two-model retrieval benchmark. No subsequent phase was started.

## Implemented behavior

- Python serves authenticated `/internal/chunks` and `/internal/embeddings` endpoints. Embeddings are generated locally in batches of up to 16 texts, with bounded input/context sizes, request concurrency, a tenant-scoped in-memory cache and explicit failures. Node indexing submits batches of four texts.
- One production embedding model is loaded lazily per Python process. Default: `Qwen/Qwen3-Embedding-0.6B`, revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`, 1,024 dimensions. Extraction's separate Gemini/Qwen Instruct configuration is preserved.
- The separate benchmark supports `microsoft/harrier-oss-v1-0.6b`, revision `f9b9dc8d367d443f2479d27aa5d8d2850c0774ee`. Both candidates are cached locally for this requested experiment, but Harrier is not loaded by the production service.
- Inference follows the official Transformers implementations: left padding, last non-padding-token pooling, L2 normalization, CPU float32 and no remote code. Model/tokenizer assets must already be cached; inference uses `local_files_only=True`. Only the explicit asset-download command accesses the public model repository.
- Official query formatting is model-specific. Qwen uses `Instruct: {instruction}\nQuery:{query}`; Harrier uses `Instruct: {instruction}\nQuery: {query}`. Documents receive no instruction prefix. Defaults and adapters follow the [official Qwen card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and [official Harrier card](https://huggingface.co/microsoft/harrier-oss-v1-0.6b).
- Structure-aware chunking uses the same pinned Qwen reference tokenizer for production and both benchmark candidates. Target 450 tokens, maximum 600 by default. It respects invoice, page, worksheet and section boundaries, packs related table rows where possible, suppresses known repeated headers/page boilerplate and preserves unit/page/cell references. Long units split at Unicode character/word boundaries. Each model still uses its own tokenizer during inference and rejects context overflow rather than silently truncating.
- Indexing streams source pages individually and worksheet cells in batches of 200. It retains original normalized text and separately labels current invoice and line facts, including manual corrections. Related source coordinates remain available in chunk source references. Short pages/sections legitimately produce chunks below 300 tokens.
- Index requests atomically create PostgreSQL indexing runs and durable processing jobs. Restricted leased outbox functions publish compact IDs to `indexing-queue`. Jobs use stable IDs, three execution attempts, exponential backoff, fenced leases and persistent failure state. Redis contains queue infrastructure, not authoritative indexing state.
- Indexed chunks/vectors and finalized runs are immutable. A completed run becomes searchable only through an atomic document-head update. Source/understanding changes and invoice/line edits increment the document generation; stale or partial runs are excluded immediately. Reindexing keeps historical chunks and reuses only compatible same-tenant/same-space vectors.
- Embedding-space SHA-256 identity includes model/revision/dimensions, adapter, query instruction, context size, chunker/source-builder versions and chunk sizes. Changing any of these requires reindexing. Cache and search cannot mix two models merely because their dimensions agree.
- Search implements exact invoice SQL, supplier/date predicates, PostgreSQL FTS/GIN, pgvector cosine HNSW and Reciprocal Rank Fusion (`k=60`). Every route has explicit tenant predicates plus forced PostgreSQL RLS. Semantic/hybrid failures are reported, with no silent change of retrieval mode.

## APIs

All public routes require the existing signed tenant/user bearer token. Readers can search/read status; reviewers and administrators can request indexing.

| Route | Behavior |
| --- | --- |
| `POST /v1/documents/:id/index` | HTTP 202 with run/job/space IDs. Body `{}` or `{"reindex":true}`. Optional `Idempotency-Key`, 8–128 safe characters. Requires a normalized document. |
| `GET /v1/documents/:id/index` | Current source generation, active model space, head/currentness and latest 20 run summaries, counts and errors. |
| `GET /v1/search?mode=exact&invoice_number=INV-101` | Exact, case-sensitive invoice-number SQL lookup; no inference needed. |
| `GET /v1/search?mode=keyword&q=paper` | PostgreSQL full-text ranking over current compatible chunks. |
| `GET /v1/search?mode=semantic&q=...` | Local instructed query embedding and cosine vector search. |
| `GET /v1/search?mode=hybrid&q=...` | Keyword/vector candidate lists combined by RRF. Default mode. |

All modes accept `invoice_number`, `supplier`, `date_from`, `date_to`, and `limit` (1–100, default 10). Supplier matching uses the existing normalized identity SQL function. Dates use ISO dates; invalid ranges fail validation. Keyword/semantic/hybrid require a nonempty `q` of at most 500 characters. Responses preserve document/invoice IDs, source references, scores and component ranks. Exact lookup reads current invoice records independently of indexing; chunk search additionally excludes rejected invoice chunks and documents outside searchable processing states.

Same-key replay returns the existing run; the same key with a different embedding space returns a conflict. Without forced reindexing, a pending/running/succeeded run for the same document generation and space is reused. Use a new key with `reindex:true` for an intentional fresh run, including recovery after a terminal failure. Indexing is explicitly requested; uploading or correcting a document does not automatically enqueue this phase's index job.

## Setup and exact commands

The existing Python Work environment was preserved:

```text
/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python
Python 3.12.13
```

The required `python -c "import sys; print(sys.executable)"` inspection found no activated `python` command in this shell. The existing interpreter was identified and verified directly. No new environment, UV project, model-serving container or host virtual environment was created.

Run from the repository root on a fresh checkout with the existing environment:

```bash
"/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -c 'import sys; print(sys.executable)'
npm ci
npm run setup:env
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-test.txt -r services/document-processor/requirements-embeddings.txt
npm run infra:up
npm run db:setup
npm run embeddings:download -- --model qwen
npm run dev
```

On the already configured machine, dependencies, infrastructure, eleven migrations and both benchmark snapshots are present. Existing application processes were left running. Use `npm run db:migrate` instead of `db:setup` when development seeds are unwanted. Do not start another set of applications on occupied ports.

Issue the existing local development reviewer token and index a real normalized document:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
curl -X POST http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/index \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: initial-index-001" \
  -H "Content-Type: application/json" -d '{}'
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/index -H "Authorization: Bearer $API_TOKEN"
curl --get http://127.0.0.1:3001/v1/search -H "Authorization: Bearer $API_TOKEN" \
  --data-urlencode 'mode=hybrid' --data-urlencode 'q=সৌর প্যানেলের চালান'
```

Replace `DOCUMENT_ID` with an actual UUID. Fictional seed object references do not exist in object storage and are not a substitute for uploading/normalizing documents. Keep tokens out of logs/source control.

## Configuration and dependencies

Root `.env.example` documents these defaults; ignored `.env` was extended without replacing credentials or the user's extraction model choices:

```dotenv
EMBEDDINGS_ENABLED=true
EMBEDDING_MODEL_ID=Qwen/Qwen3-Embedding-0.6B
EMBEDDING_MODEL_VERSION=97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3
EMBEDDING_DIMENSIONS=1024
EMBEDDING_QUERY_INSTRUCTION="Given an invoice or business document search query, retrieve relevant passages that answer the query"
EMBEDDING_CACHE_DIR=.cache/huggingface
EMBEDDING_MAX_TOKENS=2048
EMBEDDING_CPU_THREADS=4
EMBEDDING_TIMEOUT_MS=120000
CHUNK_TARGET_TOKENS=450
CHUNK_MAX_TOKENS=600
INDEX_MAX_CHUNKS=10000
```

API, worker and Python load root configuration. Relative cache paths resolve from the repository root. Restart those processes after changing configuration. Download the new pinned assets before selecting another model; update ID and revision together, then explicitly reindex documents. Harrier's revision is listed above. Only the selected model is used in production.

No new npm or Python packages were installed during this phase. The existing interpreter already provided `torch==2.14.0`, `transformers==5.22.1`, `huggingface-hub==1.33.0`, `safetensors==0.8.0`, `tokenizers==0.23.3` and `psutil==7.2.2`; these are pinned in `requirements-embeddings.txt`. Existing PostgreSQL, BullMQ, Zod and HTTP libraries were reused. Two public model snapshots were downloaded for the explicitly requested comparison into ignored `.cache/huggingface`; model assets are separate from dependency installation.

The Node application requires 1,024 dimensions because its schema is `vector(1024)`. Changing database dimensions requires a reviewed schema/index migration and compatible API contracts. Python's Qwen adapter independently supports its model's 32–1,024 dimensional Matryoshka output; Harrier accepts its native 1,024 only. The application never pads or silently truncates an incompatible model vector.

## Actual benchmark results

Reproduce using the same explicitly synthetic English/Bengali dataset and graded labels:

```bash
npm run embeddings:download -- --model qwen
npm run embeddings:download -- --model harrier
npm run benchmark:embeddings
# Separate experiments leave production configuration unchanged:
npm run benchmark:embeddings -- --qwen-only
npm run benchmark:embeddings -- --harrier-only
```

The default command writes [embeddings-comparison.json](evaluation/embeddings-comparison.json). Individual runs write `embeddings-qwen.json` or `embeddings-harrier.json`. Models execute sequentially in separate Python subprocesses, with cache reuse disabled for timing. The dataset and actual chunk hashes must match. A connection-local temporary PostgreSQL table and HNSW index hold vectors; production documents/chunks are not modified. Temporary raw-vector files are removed afterward.

Measured run: 2026-11-16T10:14:59.831Z; 30 documents, 30 chunks, 16 manually labeled queries; ARM64, 10 logical CPUs, 16 GiB system RAM; CPU float32, four inference threads. Search timing measures warm local PostgreSQL SQL round trips, separate from query embedding time. Both saved EXPLAIN plans used `embedding_benchmark_hnsw` index scans.

| Measurement | Qwen3-Embedding-0.6B | Harrier-OSS-v1-0.6B |
| --- | ---: | ---: |
| Recall@5 | 0.9792 | 0.8542 |
| Recall@10 | 0.9792 | 0.9167 |
| MRR@10 | 1.0000 | 1.0000 |
| nDCG@10 | 0.9765 | 0.9025 |
| Document embedding batch mean | 605.19 ms | 533.58 ms |
| Document embedding batch p95 | 981.45 ms | 804.41 ms |
| Query embedding mean | 86.11 ms | 79.44 ms |
| Query embedding p95 | 106.63 ms | 116.79 ms |
| PostgreSQL search mean | 0.553 ms | 0.552 ms |
| PostgreSQL search p95 | 0.858 ms | 0.696 ms |
| Model load | 2,848.97 ms | 1,733.16 ms |
| Peak benchmark-process RSS | 2.10 GiB | 3.62 GiB |

Document batches contain four chunks, with a final smaller batch. Peak RSS is sampled every 50 ms and includes the model, reference tokenizer and Python process; it is not system-wide RAM or GPU memory. Retrieval metrics are macro-averaged per query, deduplicate document IDs, and use graded relevance for nDCG. Query labels include multiple relevant documents and distractors. Zero-positive-label queries are rejected. The JSON retains per-query results, raw latency samples, model/runtime identities, hashes and plans.

This is a small synthetic smoke benchmark, not an estimate of real invoice accuracy, production throughput or filtered multi-tenant ANN recall at scale. The requested provisional Qwen default remains active; these results do not establish a universal model ranking.

## Database and rollback

Migration 0009 adds source generations, indexing_runs, run-linked immutable chunks, run/cache indexes and restricted leased index dispatch functions. Existing `vector(1024)`, cosine HNSW and generated FTS/GIN indexes are reused. Migration 0010 strengthens configuration and deferred job identity constraints and prevents lost acknowledgements from overwriting terminal execution state. Migration 0011 gives the fixed-search-path deferred guard owner privileges for its explicit tenant/job lookup after the dispatcher's function returns; direct business-table access remains denied to the dispatcher.

Eleven migrations are applied to development PostgreSQL. Normal requests use restricted runtime/dispatcher roles and tenant transactions. No duplicate-invoice uniqueness constraint was introduced.

```bash
npm run db:status
npm run db:migrate
npm run db:rollback -- --version 0011 --dry-run
```

Before an actual downgrade, stop writers, back up and export indexing run/configuration/history. Revert 0011, then 0010, then 0009 using the current head each time. Downgrading 0009 preserves every chunk/vector, remaps former run source versions to retain legacy uniqueness, records original versions in source references, cancels unfinished index jobs and removes heads/run links. Reapplying does not reconstruct removed runs or republish old vectors. Tests verify rollback preservation and reapplication in disposable databases. Prefer forward migrations on real data.

## Verification results

All commands below completed successfully on the existing machine:

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Passed all workspaces and scripts/tests |
| `npm test` | 176 Node tests and 73 Python tests passed |
| `npm run test:search` | 19 passed |
| `npm run test:ingestion` | 39 passed |
| `npm run test:database` | 47 passed |
| `npm run test:financial` | 20 passed |
| `npm run build` | Shared packages, API, worker and Next.js production builds passed |
| `npm run test:integration` | 8 live infrastructure/application checks passed |
| `npm run test:embeddings:live` | 3 real local Qwen/HTTP/chunking checks passed |
| `npm run benchmark:embeddings` | Both real models completed; metrics above |
| `npm run db:status` | All 11 migrations applied |
| `npm run infra:status` | PostgreSQL, Redis and MinIO healthy on loopback |
| `npm audit --omit=dev` | 0 vulnerabilities |

Total: **385 passing automated tests**, plus actual benchmark runs, type checking and production builds. Python emitted five existing PyMuPDF SWIG deprecation warnings. Ingestion's deliberate interrupted-storage test emits an expected SDK warning.

Final checks found zero leftover disposable test databases, test queue keys or test storage buckets. All 40 documented source/documentation files exist and have no trailing whitespace. No configured secret values were found in repository source. Root `.env` remains mode `0600`; `.env` and model cache paths are ignored by Git. The exact existing Python interpreter path was verified again after testing.

Unit tests cover model formats, pinned/offline loading, pooling/normalization, cache separation, dimension/model/version checks, chunk boundaries, Bengali splitting, strict inputs and ranking metrics. Search integration tests use real PostgreSQL/Redis/BullMQ/API and mocked vectors to exercise tenant isolation on every search path, roles, exact/filter/FTS/semantic/RRF behavior, current corrected facts alongside source text, worksheet evidence, idempotency/cache reuse, stale/concurrent source fencing, retry exhaustion/recovery, model-space separation, vector/run immutability, queue outages, lost acknowledgements, SQL payload binding and rollback preservation. Separate live checks and benchmarks use actual Qwen/Harrier weights. No mocked test is reported as measured model quality.

## Files created

- `packages/contracts/src/search.ts`
- `packages/core/src/embeddings.ts`
- `packages/database/src/search.ts`
- `packages/database/migrations/0009_local_search.sql`
- `packages/database/migrations/0010_indexing_dispatch_guards.sql`
- `packages/database/migrations/0011_deferred_index_guard.sql`
- `apps/api/src/search/routes.ts`
- `apps/worker/src/indexing.ts`
- `services/document-processor/src/document_processor/embedding_models.py`
- `services/document-processor/src/document_processor/embeddings.py`
- `services/document-processor/src/document_processor/chunking.py`
- `services/document-processor/src/document_processor/model_assets.py`
- `services/document-processor/requirements-embeddings.txt`
- `services/document-processor/tests/benchmark_embeddings.py`
- `services/document-processor/tests/test_embeddings.py`
- `scripts/benchmark-embeddings.ts`
- `scripts/check-embeddings.ts`
- `tests/fixtures/retrieval-synthetic.json`
- `tests/search/search.test.ts`
- `tests/unit/search.test.ts`
- `docs/evaluation/embeddings-comparison.json`
- `docs/phase-8-local-search.md`

## Files modified

- `.env.example`
- `package.json`
- `README.md`
- `packages/contracts/src/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/env.ts`
- `packages/database/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/ingestion/routes.ts`
- `apps/worker/src/app.ts`
- `apps/worker/src/outbox.ts`
- `services/document-processor/src/document_processor/main.py`
- `services/document-processor/tests/test_processing.py`
- `scripts/python.mjs`
- `tests/database/schema.test.ts`
- `tests/financial/financial.test.ts`
- `docs/architecture.md`
- `docs/database-schema.md`

Local-only configuration: ignored root `.env` received missing defaults while retaining credentials, permissions and existing values. Ignored `.cache/huggingface` holds public pinned model assets. Build/test outputs remain ignored. No secrets or model weights were added to source control.

## Manual actions, limitations and acceptance

No credentials or external inference account are required for local embeddings. On another machine, point `PYTHON_EXECUTABLE` at its existing Python Work interpreter, install missing pinned packages into that interpreter, explicitly cache Qwen, apply migrations and run services. Internet is needed only for explicit dependency/asset downloads. Provide a real normalized document UUID, an authorized token and an explicit index request to make uploaded content searchable. After corrections or model/configuration changes, request reindexing.

CPU inference is implemented and measured; GPU acceleration is not implemented. A process loads one model, so configuration changes need a restart. Default indexing is limited to 10,000 chunks; pages and worksheet cells are streamed, and very long units are split. Chunk batches can end below the token target. Oversized/unavailable/incompatible inputs fail explicitly. The reference tokenizer is deliberately shared across benchmark candidates; this does not make their vector spaces compatible.

PostgreSQL `simple` FTS has no Bengali linguistic stemming. HNSW is approximate, and heavily filtered or large multi-tenant corpora need recall/latency tuning on representative labels. The tiny isolated benchmark does not measure those production conditions. Semantic/hybrid requests require the local model; exact and keyword SQL paths remain independently usable. Search is exposed through REST; the existing frontend system overview is preserved. Public search/review UI belongs to a later phase.

Acceptance criteria **passed**: local batch embeddings, configurable/versioned model identity and query instruction, 1,024-dimensional cosine HNSW, structure/evidence-preserving chunks, idempotent durable indexing and reindexing, compatible-space caching, all five search requirements with tenant isolation, and reproducible actual benchmarks for both candidates. The existing Python environment was preserved. This phase stops here.
