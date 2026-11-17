# Phase 5: document classification and invoice segmentation

Implemented on 2026-11-15. Input is the verified normalized page/worksheet-row representation from phase 4. This phase classifies content and proposes evidence-backed invoice groups; it does not extract financial invoice fields, calculate totals or generate embeddings.

## Classification and grouping

The rule engine identifies invoice, receipt, other_business and unknown content. It uses anchored headers, explicit invoice identifiers/suppliers, source page counters, repeated identities and line-item continuation signals. Receipts referring to an invoice remain receipts. Purchase orders, quotations, delivery notes, statements, credit notes and proforma headers are treated as other business documents rather than tax invoices.

Confirmed same-identity continuations can share one candidate across pages. Conflicting identifiers or suppliers, page-number resets and completed-page sequences split candidates. A repeated identifier without continuation evidence stays split and is flagged as ambiguous. Missing identity/supplier evidence, broken/incomplete page sequences, low OCR confidence, source errors and ambiguous boundaries require manual review. Space-separated/uncertain identifiers are flagged instead of silently treating a prefix as the whole identity.

Unlabeled continuation pages are retained even when there is insufficient evidence to attach them. Unknown/blank/error pages are represented explicitly. If two invoice identities occur on one page, the page remains an ambiguous candidate; this implementation does not invent sub-page invoice boundaries. Evidence quotes and source references make the decision reviewable. Confidence values are deterministic rule scores, not statistically calibrated probabilities.

For XLSX, XLS and CSV, recognized invoice-ledger headers identify record candidates with worksheet/row/cell references. Line items are grouped only inside a confirmed invoice identity/context; conflicting record keys split them. Duplicate ledger records stay separate. Repeated invoice identifiers in another worksheet are not automatically merged. Unknown records, empty worksheets and late worksheet errors remain reviewable.

The engine consumes the canonical record stream once alongside existing bounded source persistence. It buffers one worksheet row, limits classification text to 512 characters/cell and 131,072 characters/row, and flags SIGNAL_TEXT_LIMIT where these signal limits apply. Full source values remain unchanged in the original canonical artifacts and PostgreSQL evidence. At most 10,000 candidates are retained; overflow becomes an explicit unknown/review range rather than disappearing. Candidate evidence is limited to 24 short quotes, while source page/range references remain complete within the existing document limits.

## InvoiceCandidate contract

Shared Zod contracts define:

| Field | Meaning |
| --- | --- |
| candidate_id | Stable UUIDv5 scoped to document, normalized run, algorithm version and ordinal |
| document_id | Original document UUID |
| document_type | invoice, receipt, other_business or unknown |
| source_pages | Logical page/frame/worksheet ordinals |
| source_worksheets | Worksheet names; PDFs/images use an empty list; CSV uses its normalized CSV source label |
| source_locations | Source kind/page/worksheet, row range, A1 cell range, start/end artifact and JSONL line, signal-limit flag |
| segmentation_confidence | Rule score in [0,1] |
| requires_manual_review | Explicit uncertainty/review flag |
| review_reasons | Stable reason codes such as AMBIGUOUS_BOUNDARY or MISSING_RECORD_IDENTIFIER |
| evidence | Signal, bounded quote, page/worksheet/cell anchor |
| advisor_suggestion | Optional structured AI advice; separate from the actual classification/grouping |

Normalized original file/hash references and source versions remain on the processing checkpoint, canonical manifest and database source evidence. No source document is rewritten. Row ranges can span several JSONL shards, so both artifact endpoints are preserved. Table headers can be shared contextual evidence; candidates retain their actual source ranges.

## Persistence, retries and result API

Migration 0006 adds document_understanding_runs and invoice_candidates. Both tables have composite tenant/document foreign keys, forced RLS, restricted SELECT/INSERT grants, immutable row/truncate triggers, audit events and appropriate document/review indexes. Candidate IDs/JSON identity/type/confidence/review fields are constrained consistently. There is no invoice-number uniqueness constraint; legitimate repeated records are representable.

The worker reads normalized artifacts through the existing authenticated client and validates hashes/records before understanding them. Final candidate/run inserts, authoritative job completion, document classification and publication of metadata.understanding commit in one fenced tenant transaction. Successful job replays produce no additional candidate snapshots. Failed attempts can leave earlier immutable source snapshots, but no partially published active understanding run. The active run identifies the normalized source version/manifest. Existing normalized runs completed before this phase are preserved without automatic backfill.

The understanding run exposes the four classification types. The legacy document DTO maps other_business to other and uses invoice_bundle when consistently invoice content produces multiple invoice candidates. Processing status still reports processing success/failure; review uncertainty is a separate explicit flag, so processed does not mean reviewed or financially approved. A mixed-content document gets unknown with MIXED_DOCUMENT_TYPES while retaining the individual classifications.

```text
GET /v1/documents/:id/understanding?limit=50&cursor=...
Authorization: Bearer <existing tenant/user JWT>
```

The response has document_id, run, candidates and next_cursor. The run contains algorithm/source versions, classification/confidence/review flag, counts, AI status/warnings and creation time. Limit accepts 1–100. Cursors bind to the active run; a changed version returns 409 RESULT_VERSION_CHANGED. Foreign documents return 404, unauthenticated calls 401, and invalid queries/cursors 400. Before understanding exists, the response has run:null, candidates:[] and next_cursor:null; it does not invent results. Repeatable-read tenant transactions keep each result page consistent.

## Optional, approved-cloud advice

Deterministic uncertainty is sufficient to preserve candidates and complete processing. Gemini advice is optional and disabled by default. When explicitly enabled, all of these conditions are required before an external call:

1. A candidate has insufficient deterministic evidence and requires review.
2. The document's current PostgreSQL cloud_processing_allowed is true, with cloud_approved_by and cloud_approved_at present.
3. Configuration supplies a Gemini API key/model. The approval is freshly checked per call and checked again in the durable pre-call checkpoint update.
4. The current execution lease is still valid and the audit checkpoint commits successfully.

The checkpoint records provider/model, candidate, input hash, approval snapshot and request time. The official @google/genai SDK targets the fixed Gemini API endpoint with Vertex mode disabled, a 10-second deadline, one attempt and a 512-output-token cap. Each request contains only up to 480 relevant source characters from the candidate plus up to 480 from its predecessor, not files, object URLs or whole normalized documents. Source text is treated as untrusted data; no tools, financial extraction or calculation are requested.

Validated advice has proposed_document_type, same_invoice_as_previous and confidence. It is retained as a review-only suggestion. It cannot override deterministic identity conflicts, automatically merge groups, discard pages or approve totals. Errors/invalid responses preserve original uncertainty; disabled/not-permitted/not-needed/advised/unavailable/budget-exhausted statuses remain explicit. Five calls/document are allowed by default, configurable 1–10. No local Qwen/embedding model is downloaded in this phase.

No real Gemini request or cloud accuracy evaluation was performed: no credentials/model were configured and documents remain unapproved by default. Controlled provider tests verify the approval/audit/revocation/budget paths. Actual provider credentials, access, billing and model availability require manual configuration if this optional feature is enabled. Select a currently available model from the [official model documentation](https://ai.google.dev/gemini-api/docs/models); structured output uses the [official Gemini JSON-schema interface](https://ai.google.dev/gemini-api/docs/structured-output).

## Run and configure

The tested migration is already applied to this local development database. Start with:

```bash
npm run dev
```

For an existing checkout/database that has not received this phase:

```bash
npm ci
npm run setup:env
npm run infra:up
npm run db:migrate
npm run dev
```

For a fresh database with fictional development fixtures, use db:setup instead of db:migrate. See the README for the existing Python installation prerequisites. No Python package installation or environment creation is needed for this phase. The exact interpreter remains /Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python. Existing Tesseract/English data and missing Bangla OCR language data remain as reported in phase 4; deterministic rules preserve existing Bangla Unicode text independently of OCR installation.

Issue a local development token and read results after uploading through the existing API:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
curl http://127.0.0.1:3001/v1/documents/DOCUMENT_ID/understanding \
  -H "Authorization: Bearer $API_TOKEN"
```

Replace DOCUMENT_ID with an accepted document UUID. The token is a credential; keep it out of source/shared logs. Uploads automatically pass through normalization and understanding. Existing frontend source remains the system overview; this phase's results are exposed through REST.

New root configuration, with existing values preserved:

| Setting | Default |
| --- | --- |
| SEGMENTATION_AI_ENABLED | false |
| SEGMENTATION_AI_MAX_CALLS | 5 |
| GEMINI_API_KEY | empty; supply only if enabling approved cloud advice |
| GEMINI_SEGMENTATION_MODEL | empty; explicitly select an available Gemini model if enabling advice |

An API key/enable flag does not itself approve a document. This phase reads the existing document approval fields; it does not introduce a public approval UI/endpoint. Approval must be recorded through a trusted administrative workflow with appropriate tenant/actor context. Root .env remains ignored with mode 0600. Production needs separate secret delivery and appropriate TLS/identity configuration.

## Dependencies and files

Added @google/genai 3.3.0 to the worker using npm workspaces. The SDK requires Node >=22 and was verified on the existing Node 24.18.0. Installation added 35 packages; exact transitive versions are in package-lock.json. npm reported zero audit vulnerabilities. No Python/system dependency, AI model, environment or package manager was added/replaced. The npm warning for transitive node-domexception deprecation and existing/pending install-script approvals did not prevent the verified builds/tests; no script-approval settings were changed.

Created:

```text
packages/contracts/src/understanding.ts
apps/worker/src/understanding/signals.ts
apps/worker/src/understanding/engine.ts
apps/worker/src/understanding/advisor.ts
apps/worker/src/understanding/persistence.ts
apps/api/src/ingestion/understanding.ts
packages/database/migrations/0006_document_understanding.sql
tests/fixtures/understanding.ts
tests/unit/understanding.test.ts
tests/unit/understanding-advisor.test.ts
services/document-processor/tests/create_understanding_fixtures.py
scripts/evaluate-understanding.ts
docs/evaluation/segmentation-synthetic.json
docs/phase-5-understanding.md
```

Modified:

```text
.env.example
package.json
package-lock.json
apps/worker/package.json
packages/core/src/env.ts
packages/core/tests/env.test.ts
packages/contracts/src/index.ts
apps/worker/src/ingestion.ts
apps/worker/src/processing.ts
apps/worker/src/app.ts
apps/api/src/ingestion/routes.ts
tests/database/schema.test.ts
tests/ingestion/ingestion.test.ts
README.md
docs/architecture.md
docs/database-schema.md
docs/ingestion.md
```

The ignored .env also received four missing configuration defaults, preserving existing credentials/settings and interpreter. Previous SQL migrations, Python engine/runtime requirements, frontend source, Docker configuration and existing seed data were preserved. No commit or remote publication was created; earlier-phase files remain untracked in this repository.

## Actual verification

```bash
npm run typecheck
npm test
npm run test:database
npm run test:ingestion
npm run evaluate:segmentation
npm run build
```

With infrastructure and all four applications running, also run npm run test:integration. On macOS the full final command used task-scoped caffeinate to prevent the idle sleep interruptions previously observed on this host; no global power settings were changed.

| Check | Actual result |
| --- | --- |
| Strict TypeScript checks | Passed |
| Node unit tests | 79 passed, 0 failed |
| Existing Python/OCR regression | 60 passed, 0 failed; five third-party SWIG deprecation warnings |
| PostgreSQL schema/security/rollback | 41 passed, 0 failed |
| Real upload/processing/segmentation integration | 28 passed, 0 failed |
| Live application/infrastructure integration | 8 passed, 0 failed |
| Production builds including Next.js | Passed |
| Total automated tests | 216 passed, 0 failed |

Unit tests cover single/multi-page invoices, bundles, repeated information, continuation tables, supplier conflicts, resets, ambiguous and missing pages, receipt/business/unknown classification, XLSX-style ledger/line-item records, missing identifiers, duplicate records, worksheet separation, split row records, source errors, signal/candidate bounds and stable IDs. Cloud-policy tests prove no call for disabled/sufficient/unapproved content, required approver/time, durable audit-before-call, revocation checks, bounded calls/excerpts, separate advice and provider failure handling.

Real-format integration tests upload generated PDFs/XLSX/XLS/CSV through the API, normalize them in the existing Python service, process them through BullMQ, verify the expected candidate groups/types/ranges in PostgreSQL and read the paginated result API. Database tests verify new-table tenant isolation/identity/FKs, immutability, atomic audit rollback, migration-0006 pointer cleanup and full down/up migrations. Original ingestion, private-storage and failure-recovery tests also pass. Disposable resources are cleaned up.

Final checks confirmed all six migrations applied, PostgreSQL/Redis/MinIO healthy, and zero remaining disposable test databases/buckets/Redis keys. A scan of 122 Git-visible files found no configured secret values or trailing whitespace; .env remains ignored with mode 0600. Verification applications and their temporary idle-sleep prevention were stopped afterward; Docker infrastructure remains running.

[segmentation-synthetic.json](evaluation/segmentation-synthetic.json) contains actual engine output from 12 labeled synthetic normalized fixtures: classification accuracy 1.0, exact grouping accuracy 1.0, review-decision accuracy 1.0, PDF boundary precision/recall 1.0, zero falsely merged page pairs and zero uncovered PDF pages. These hand-authored regression templates are not a held-out or representative real-document benchmark. No AI scores or model results were invented.

## Limitations, rollback and acceptance

- Header/identifier/counter rules are conservative heuristics with English and selected Bangla labels, not universal layout/language understanding. Unrecognized formats, identifiers with spaces and missing/uncertain identity evidence require review.
- No automatic sub-page splitting or nonadjacent/cross-worksheet joining is attempted. Multiple identities on one page, unidentified continuation pages and ambiguous boundaries remain visible for review.
- Spreadsheet detection expects supported recognizable headers or explicit invoice label/value context. Blank rows can end a ledger, unfamiliar headers remain uncertain, and formula-produced IDs without a usable source value may remain unknown. Original formula/cache evidence is preserved for later extraction/review.
- Numeric confidence is not calibrated. Signal/candidate limits preserve source references and flag uncertainty; they do not imply complete semantic recognition of every large record.
- Optional Gemini calls are implemented but not verified against a live paid endpoint in this phase. Advice is review-only; a future review/correction workflow must explicitly resolve suggestions. Approval revocation is checked before dispatch; an already authorized in-flight request cannot be recalled.
- Historical successful processing runs are not automatically backfilled. There is no new frontend review UI, public manual segmentation correction or failed-job reprocessing endpoint in this phase.
- Run/candidate snapshots are immutable and retained; retention cleanup and later invoice extraction are separate work. No financial calculation, invoice-field extraction, duplicate-invoice adjudication, embeddings or reconciliation was added.

Migration 0006 is additive. To inspect rollback use npm run db:rollback -- --version 0006 --dry-run. Stop writers and back up before an actual downgrade: Down deletes candidate/run data, clears active pointers and restores generic document typing, while preserving original files, normalized source evidence and audit history. Reapplying Up does not restore deleted classifications. Prefer forward fixes once real candidates exist.

The requested phase acceptance checks passed. The existing Python environment is preserved, PostgreSQL remains authoritative, uncertain content stays represented, and cloud advice is disabled unless explicitly configured and approved. Stop after this phase.
