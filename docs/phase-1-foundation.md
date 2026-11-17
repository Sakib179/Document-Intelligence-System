# Phase 1: project foundation

Completed on November 15, 2026 (Asia/Dhaka). This report covers foundation work only.

## Implemented

- npm workspaces with Node 24, TypeScript strict mode, exact direct dependency versions, and a lockfile.
- Independently executable Fastify API and BullMQ worker, Next.js frontend, and Python FastAPI service.
- Shared Zod health and operational-job contracts; shared configuration and connection packages.
- Root environment validation and an idempotent setup command generating random local credentials in an ignored, mode-0600 `.env`.
- Separate liveness/readiness endpoints, bounded connection timeouts, sanitized dependency failures, security headers, and shutdown handlers.
- Password-protected PostgreSQL/pgvector and Redis, plus a private MinIO bucket with an authenticated/anonymous access test.
- Version/digest-pinned infrastructure and a nonroot MinIO container built from pinned official upstream source.
- A responsive Next.js overview with real readiness checks, refresh, and periodic updates. Future document features are explicitly labeled planned.
- Initial README, architecture diagram, automated tests, and this verification/file inventory.

The original assignment PDF was preserved. Git was initialized locally on `main`; no commit or remote push was made.

## Actual verification results

| Command or check | Result |
| --- | --- |
| `npm run infra:config` | Passed: Compose configuration valid |
| `npm run infra:up` | Passed: all three containers healthy and private bucket initialized |
| `npm run typecheck` | Passed: shared packages, Node applications, frontend, tools, and test sources |
| `npm test` | Passed: 16 Node unit tests and 6 Python tests |
| `npm run build` | Passed: packages, API, worker, optimized Next.js production build |
| `npm start` | All four compiled/service processes started; production integration checks passed |
| `npm run dev` | All four development processes started; development integration checks passed |
| `npm run test:integration` | Passed: 8 live integration tests, zero failures |
| Redis interruption/recovery | Passed: API/worker liveness stayed 200, readiness became 503, then recovered to 200 after Redis restart |
| Credential checks | Passed: `.env` mode 0600, Git-ignored, and no generated credentials in candidate source files |
| Existing Python checks | Passed: exact interpreter and required installed versions retained; no repository/service virtual environment created |

The eight live integration tests cover:

1. Authenticated PostgreSQL access, installed pgvector, and an actual vector-distance query.
2. Authenticated Redis write/read/delete with a bounded key lifetime.
3. Authenticated MinIO upload/read/delete and HTTP 403 for an anonymous read of the same object.
4. API liveness and dependency readiness over HTTP.
5. Worker liveness and consumer/dependency readiness over HTTP.
6. Python service liveness/readiness using the shared response contract.
7. A real BullMQ job submitted to and completed by the running worker.
8. Next.js page rendering, web health, and aggregate status reporting all four services ready.

These are foundation test results, not invoice extraction/OCR evaluation metrics. No extraction accuracy or throughput claim is made. No browser automation was run; frontend verification covered production compilation and live HTTP responses, including the aggregate status route.

## Run commands

From the repository root, for a fresh checkout with the existing Python environment and Docker Desktop available:

```bash
npm ci
npm run setup:env
npm run infra:up
npm run dev
```

Open http://127.0.0.1:3000. In another terminal:

```bash
npm run typecheck
npm test
npm run test:integration
```

For production build verification, stop development processes first, then:

```bash
npm run build
npm start
```

Infrastructure shutdown preserves data:

```bash
npm run infra:down
```

## Existing Python environment

The first requested `python -c "import sys; print(sys.executable)"` command found no `python` on the nonactivated shell PATH. The verified existing interpreter is:

```text
/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python
```

It is Python 3.12.13 and belongs to the existing UV environment. No Python dependency installation or environment creation/synchronization command was executed. The launch/test script verifies the executable identity and virtual-environment prefix before invoking it.

Reused requirements: FastAPI 0.162.0, Uvicorn 0.54.0, Pydantic 2.14.3; test requirements: HTTPX 0.28.1 and pytest 9.2.0. The Python service manifests record these existing versions.

## Configuration and limitations

- Docker Desktop must be running. Initial builds/installations need registry, GitHub, and Go module network access.
- Port 5432 was occupied by an existing service. This project uses host port **55432**, preserving that service. Other defaults are web 3000, API 3001, worker 3002, processor 8000, Redis 6379, and MinIO 9000/9001.
- Root `.env` is already generated locally. Other machines must set `PYTHON_EXECUTABLE` to their existing environment; never create a replacement environment.
- MinIO uses pinned upstream community source because the official prebuilt release image was unavailable. Its upstream repository is archived. The initial source build is slower than pulling a binary image; Alpine package repositories are not frozen snapshots. See the README for the upstream references.
- Dedicated local PostgreSQL owner and MinIO root credentials are used for this phase. User authentication, least-privilege application roles, TLS, and public deployment remain future work. Published ports are loopback-only.
- The worker consumes operational health probes only. No business processing is queued or claimed complete.
- No uploads, document schema, parsing, OCR, AI extraction, model downloads, embeddings, financial validation, reconciliation, or search were implemented.
- npm's installation audit reported zero vulnerabilities. BullMQ 5 brings deprecated transitive `cron-parser` and `node-abort-controller` packages; retain the lockfile and review that dependency line before a later major upgrade.
- No manual credentials or cloud API keys are required for this foundation. MinIO console credentials are in the ignored root `.env`; do not paste them into source control.

All acceptance criteria for this foundation phase passed. Infrastructure remains available locally; temporary application verification processes are stopped after checks. Start them with `npm run dev`.

## Installed Node dependencies

The following table lists every direct external dependency declared by the root or workspaces. Transitive versions are recorded in `package-lock.json`. Internal workspace packages are linked locally.

| Package | Pinned version |
| --- | --- |
| `@aws-sdk/client-s3` | `3.1169.0` |
| `@fastify/helmet` | `13.2.0` |
| `@types/node` | `24.19.2` |
| `@types/pg` | `8.23.1` |
| `@types/react` | `19.3.0` |
| `@types/react-dom` | `19.3.0` |
| `bullmq` | `5.81.5` |
| `concurrently` | `10.0.7` |
| `dotenv` | `18.0.10` |
| `fastify` | `5.12.8` |
| `ioredis` | `5.11.1` |
| `next` | `16.4.6` |
| `pg` | `8.23.1` |
| `react` | `19.3.1` |
| `react-dom` | `19.3.1` |
| `tsx` | `4.23.15` |
| `typescript` | `5.9.3` |
| `vitest` | `5.1.0` |
| `zod` | `4.6.7` |

## Created files

All listed source/configuration/documentation files are new; no pre-existing source was modified. The original `Ai Engineer Task 1.3.pdf` is excluded from this list because it was unchanged.

- `.env.example`
- `.gitignore`
- `.npmrc`
- `.nvmrc`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/main.ts`
- `apps/api/tsconfig.json`
- `apps/web/AGENTS.md`
- `apps/web/next.config.ts`
- `apps/web/package.json`
- `apps/web/src/app/api/health/route.ts`
- `apps/web/src/app/api/system-health/route.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/system-status.tsx`
- `apps/web/tsconfig.json`
- `apps/worker/package.json`
- `apps/worker/src/main.ts`
- `apps/worker/src/processor.ts`
- `apps/worker/tsconfig.json`
- `docs/architecture.md`
- `docs/phase-1-foundation.md`
- `infra/compose.yaml`
- `infra/minio/.dockerignore`
- `infra/minio/Dockerfile`
- `infra/postgres/001-extensions.sql`
- `package-lock.json`
- `package.json`
- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/tests/contracts.test.ts`
- `packages/contracts/tsconfig.json`
- `packages/core/package.json`
- `packages/core/src/connections.ts`
- `packages/core/src/env.ts`
- `packages/core/src/health.ts`
- `packages/core/src/index.ts`
- `packages/core/src/shutdown.ts`
- `packages/core/tests/env.test.ts`
- `packages/core/tests/health.test.ts`
- `packages/core/tsconfig.json`
- `packages/database/package.json`
- `packages/database/src/index.ts`
- `packages/database/tsconfig.json`
- `scripts/bootstrap-storage.ts`
- `scripts/check-foundation.ts`
- `scripts/python.mjs`
- `scripts/setup-env.mjs`
- `scripts/web.mjs`
- `services/document-processor/pyproject.toml`
- `services/document-processor/requirements-test.txt`
- `services/document-processor/requirements.txt`
- `services/document-processor/src/document_processor/__init__.py`
- `services/document-processor/src/document_processor/main.py`
- `services/document-processor/tests/test_health.py`
- `tests/unit/worker.test.ts`
- `tsconfig.base.json`
- `tsconfig.tools.json`
- `vitest.config.ts`

Local generated artifacts also include ignored `.env`, `node_modules/`, `.npm-cache/`, TypeScript `dist/` and build metadata, Next.js `.next/`/`next-env.d.ts`, and pytest cache. Git metadata and Docker named volumes/build caches were created. None of these runtime artifacts contains changes to the existing Python environment.
