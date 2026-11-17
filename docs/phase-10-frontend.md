> Historical phase report: user sign-in and access tokens were subsequently removed. See [current local workspace behavior](local-workspace.md).

# Phase 10 — Next.js document workspace

Completed on 2026-11-17. The frontend is a functional TypeScript/Next.js workspace backed by the existing Fastify APIs and PostgreSQL data. No hardcoded invoice records, fabricated metrics or automatic privileged login are used. This phase is local repository work; no hosted Site or deployment was created.

## Screens implemented

| Screen | Implemented behavior |
| --- | --- |
| Dashboard `/` | Actual tenant document totals, source-completed/processing/failed counts, invoices awaiting review, recent documents and processing activity. Data refreshes every 10 seconds. |
| Upload `/upload` | Multiple files, drag/drop, extension/empty/count/size feedback from server-configured limits, actual XHR byte progress, server acceptance, stable request keys, cancellation/retry and live per-document batch status. |
| Documents `/documents` | Filename, semantic type, upload time, processing state, current financial validation state, provider/model, filename/status/type/provider filters and cursor pagination. |
| Details `/documents/:id` | Original page/image rendering beside current invoice fields, line items, supporting quotes/source references, page/worksheet navigation, source text/tables/cells, OCR method/confidence, validation issues, provider/model/version and processing jobs/recovery. |
| Review `/reviews` | Current invoices, uncertain candidates, unresolved validation issues and failed jobs; opens document review. Authorized users correct headers/lines, compare immutable original values, supply reasons, save optimistic revisions and inspect attributable audit history. |
| Search `/search` | Keyword, semantic, hybrid and SQL invoice-field search; invoice number, supplier, date, currency and exact decimal amount filters. Ranked top-50 results retain document/invoice/page/source references. |
| Reconciliation `/reconciliation` | Select/search/paginate source choices, create PDF/PDF or PDF/Excel/CSV comparisons, inspect preserved left/right values, highlight discrepancies and uncertainty, and page through saved comparison history. |

`/login` provides token-based sign-in using the existing backend authentication model. `/system` preserves the operational service-status UI. Responsive navigation, table scrolling, loading/error/empty states, keyboard focus, accessible labels, read-only roles and reduced-motion preferences are supported. Desktop and 390-pixel mobile screens were checked in actual Chrome and screenshots.

Completed document counts mean source normalization is complete; they do not imply financial approval. Workflow progress, financial validation and human review remain separate. All missing invoice values remain explicitly missing. Upload transfer completion is followed by server validation; only HTTP 202 produces an accepted-batch message. Canceling a review never reports a successful save.

## Authentication and privacy

The web server verifies an access token with `GET /api/v1/me` before setting an HttpOnly, SameSite=Strict session cookie. Production cookies require Secure. Token lifetime is bounded by JWT expiry and at most one hour. Tokens are not written to local storage, session storage, URLs or HTML. Logout clears the cookie; every backend request still verifies signature/issuer/audience/expiry, active database identity, tenant and permissions.

The Next.js same-origin proxy exposes only specific supported paths/methods and a fixed server-configured API origin. Traversal/arbitrary proxy targets are rejected. Mutations and session changes require an exact matching Origin. Login bodies are bounded while streaming, including requests without Content-Length. Private originals/previews pass through authenticated servers; MinIO remains private. Data responses use no-store caching. Source text and formulas render as escaped text rather than HTML or executable code.

Readers can inspect data; upload/correction/recovery/comparison creation require existing reviewer/admin authorization. The browser also disables these actions for readers; backend checks remain authoritative. This phase reuses signed workspace tokens and does not introduce a password database, public enrollment or an identity-provider integration.

## Backend additions required by the UI

All additions are exposed under `/api/v1` with existing `/v1` aliases, authentication, tenant transactions, input validation and shared Zod output contracts:

- `GET /api/v1/me`: actual user/role/tenant and configurable upload limits.
- `GET /api/v1/dashboard`: SQL aggregates and recent persisted processing activity.
- `GET /api/v1/workspace/documents`: filtered, cursor-paginated document summaries using current financial validation checks and current-source extraction provenance.
- `GET /api/v1/workspace/reconciliations`: paginated comparison history and source filenames.
- `GET /api/v1/documents/:id/pages`: current source-version page/worksheet/OCR metadata with version-bound cursors.
- `GET /api/v1/documents/:id/pages/:number`: original normalized text and up to 100 blocks/cells per request, with continuation.
- `GET /api/v1/documents/:id/content`: authorized streaming of original bytes, safe content disposition, private caching and single-byte-range support.
- `GET /api/v1/documents/:id/preview?page=1`: private PNG rendering of one original page/frame.

Invoice results additionally include provider/model/version/prompt provenance selected for each invoice. Audit history includes the actor's display name alongside the stored actor ID. Currency and amount predicates are applied to exact, filter, keyword, semantic and hybrid search paths. Monetary filter values remain decimal strings and PostgreSQL NUMERIC comparisons; financial arithmetic is not moved into the UI.

The Python preview endpoint is internal and bearer-authenticated. It verifies the existing storage reference, bucket, byte count and SHA-256, streams the original into a temporary file and renders one bounded page/frame. Output is at most 1,600 pixels per side; image input is capped at 40 million pixels, and two previews may run concurrently. PDF documents are opened from disk, rather than copied wholesale into Python memory. No OCR, macros or model inference run for previews. Temporary originals are removed after rendering.

No new database migration, table, infrastructure service or model download was needed. PostgreSQL remains the source of truth; existing twelve migrations and tenant RLS are preserved. Existing extraction and embedding model selections were retained.

## Exact run commands

From the repository root, when services are not already running:

```bash
npm ci
npm run setup:env
npm run infra:up
npm run db:migrate
npm run dev
```

Open **http://127.0.0.1:3000**. Existing services were left running; do not start duplicate processes on occupied ports.

For the fictional seeded development reviewer, issue a token locally:

```bash
npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
```

Paste the returned credential into the sign-in form. Keep it out of source control and shared logs. Use actual tenant/user IDs for other accounts. An expired token must be renewed. The web server reads API host/port and existing secrets from server-side environment configuration, not client constants.

Actual AI extraction still requires an available private Qwen endpoint or approved Gemini configuration from earlier phases. Semantic search/indexing needs the pinned local embedding assets already configured in phase 8. Existing fictional seed records intentionally have no original MinIO object; the UI shows unavailable previews rather than inventing source files. Upload real documents to exercise the complete workflow.

## Dependencies and Python environment

Installed one development dependency: **playwright-core@1.65.1**, pinned in package.json/package-lock.json. It uses the already installed Chrome executable; no browser binary was downloaded. No new production npm or Python package was installed. Rendering reuses existing PyMuPDF and Pillow.

The existing Python Work interpreter was verified and reused:

```text
/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python
```

The required shell `python -c` inspection found no activated python alias, so the exact existing interpreter was checked directly. No virtual environment was created, recreated, synchronized or deleted.

## Verification and actual results

```bash
npm run typecheck
npm test
npm run test:frontend
npm run test:search
npm run test:database
npm run test:financial
npm run test:integration
npm run test:embeddings:live
npm audit --omit=dev
```

| Check | Actual result |
| --- | --- |
| TypeScript | Passed packages, API, worker, frontend and tools/tests |
| Node unit tests | 192 passed |
| Python tests | 77 passed, including PDF/TIFF preview, source integrity and internal authentication |
| `test:frontend` | Production build passed; 80 integration checks passed: existing 58 ingestion/extraction/workflow checks, 9 new workspace API checks and 13 actual Chrome workflows |
| Search integration | 19 passed |
| Database integration | 47 passed |
| Financial integration | 20 passed |
| Live infrastructure/application checks | 8 passed |
| Real local Qwen embedding HTTP checks | 3 passed |
| Production dependency audit | 0 vulnerabilities |

Total: **446 passing automated tests**. Final checks found all 50 documented files, no configured secret values in source or 22 browser build assets, and no leftover disposable databases, queue keys or test storage buckets. Root .env remains ignored with mode 0600. The frontend command includes the existing backend suites; these are counted once. It launches isolated Next.js/API/worker instances and reuses the test harness's disposable PostgreSQL database, Redis namespace, MinIO bucket and exact Python interpreter. Production Next.js output is separate from the user's `.next/dev` server state.

Chrome checks cover page/proxy protection, exact-origin write rejection, verified HttpOnly/Secure/Strict cookies, no local-storage/raw-token HTML exposure, real multi-file uploads and batch status, source metadata refreshing when a document is opened before processing finishes, filtering/pagination, private original previews/source evidence/model metadata, real correction/audit/revalidation, cancel behavior, review queue, currency/amount search, PDF/PDF and PDF/spreadsheet discrepancies, worksheet source rendering, mobile overflow, request errors, read-only roles and logout. Backend tests cover tenant isolation, aggregates, current validation/provenance, source pages, original byte ranges, actual PNG bytes and all search modes with exact monetary filters.

Workflow tests use mocked extraction/embedding inference for repeatability. They use real HTTP, Next.js, PostgreSQL, Redis/BullMQ, object storage, PDF/spreadsheet normalization and rendering. Real embedding inference has its own live checks. No external-model quality or OCR accuracy claim is inferred from UI tests.

Screenshots from the isolated synthetic test workspace are saved under ignored `.cache/frontend/`: dashboard-desktop.png, dashboard-mobile.png, document-details.png and reconciliation.png. The existing Chrome binary is used by default on this machine. On another machine, set CHROME_EXECUTABLE to an existing compatible Chrome/Chromium path before `npm run test:frontend`.

## Files created

- `packages/contracts/src/workspace.ts`
- `apps/api/src/workspace/service.ts`
- `apps/api/src/workspace/routes.ts`
- `services/document-processor/src/document_processor/preview.py`
- `services/document-processor/tests/test_preview.py`
- `apps/web/src/lib/backend.ts`
- `apps/web/src/lib/client.ts`
- `apps/web/src/lib/security.ts`
- `apps/web/src/lib/types.ts`
- `apps/web/src/lib/upload.ts`
- `apps/web/src/lib/evidence.ts`
- `apps/web/src/components/ui.tsx`
- `apps/web/src/components/shell.tsx`
- `apps/web/src/components/document-table.tsx`
- `apps/web/src/components/document-detail.tsx`
- `apps/web/src/components/invoice-review.tsx`
- `apps/web/src/app/api/session/route.ts`
- `apps/web/src/app/api/backend/[...path]/route.ts`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/login/sign-in.tsx`
- `apps/web/src/app/error.tsx`
- `apps/web/src/app/(workspace)/layout.tsx`
- `apps/web/src/app/(workspace)/loading.tsx`
- `apps/web/src/app/(workspace)/page.tsx`
- `apps/web/src/app/(workspace)/upload/page.tsx`
- `apps/web/src/app/(workspace)/documents/page.tsx`
- `apps/web/src/app/(workspace)/documents/[id]/page.tsx`
- `apps/web/src/app/(workspace)/reviews/page.tsx`
- `apps/web/src/app/(workspace)/search/page.tsx`
- `apps/web/src/app/(workspace)/reconciliation/page.tsx`
- `apps/web/src/app/(workspace)/system/page.tsx`
- `tests/unit/frontend.test.ts`
- `tests/ingestion/workspace-cases.ts`
- `tests/ingestion/frontend-cases.ts`
- `docs/phase-10-frontend.md`

## Files modified or replaced

- `apps/web/src/app/globals.css`
- `apps/web/src/app/layout.tsx`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/search.ts`
- `packages/database/src/search.ts`
- `packages/database/src/workflow.ts`
- `apps/api/src/ingestion/routes.ts`
- `apps/api/src/workflow/openapi.ts`
- `services/document-processor/src/document_processor/main.py`
- `tests/ingestion/ingestion.test.ts`
- `package.json`
- `package-lock.json`
- `tsconfig.tools.json`
- `README.md`
- `docs/architecture.md`

Removed `apps/web/src/app/page.tsx`; the root dashboard now lives in the authenticated workspace route group. Existing system-status components and health endpoints were retained. No secrets, model weights or screenshots were added to source control.

## Limits and acceptance

Token issuance remains an administrator/developer step; public identity enrollment and deployment/TLS configuration are outside this phase. Polling is used instead of SSE. Search returns bounded top-k results, with all monetary and tenant filters executed in PostgreSQL. Document-level passages with uncertain invoice ownership retain document-level evidence rather than an invented invoice assignment.

Original preview rendering is one bounded page/frame per request; it is not an editable PDF/Office viewer. Spreadsheet previews show preserved normalized source cells/cached values/formula text. Source blocks/page lists, result invoices, review/history records and reconciliation history have continuation controls. Existing line corrections are limited to 20 changed lines per save; insertion/deletion of invoice lines remains outside the backend contract. Document summaries inspect up to 20 current invoices and conservatively require review above that limit. Very large documents still use the existing bounded processing/indexing policies.

Acceptance passed: all seven requested screens use actual APIs, including authenticated tenant access, real metrics, upload progress/batch state, source previews/evidence/OCR, original-preserving review/audit, search filters, highlighted reconciliation discrepancies, responsive layout, loading/error/empty states and pagination. No fake records or success indicators are used. The existing Python environment is preserved. This phase stops here.
