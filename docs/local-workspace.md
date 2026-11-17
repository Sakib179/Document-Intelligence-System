# Local workspace without sign-in

The application opens directly at http://127.0.0.1:3000. User sign-in, JWT verification, access-token generation, session creation and sign-out were removed at the user's request. Old `/login` bookmarks redirect to `/`; `/api/session` no longer exists. No replacement credential is generated behind the scenes.

## Configuration and identity

The root `.env` selects an existing active workspace and operator:

```dotenv
LOCAL_WORKSPACE_TENANT_ID=11111111-1111-4111-8111-111111111111
LOCAL_WORKSPACE_USER_ID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
```

These defaults match the development seed. The local `.env` was updated while preserving its other settings and mode 0600. For a new installation, run the README setup commands, including `npm run db:seed`. No new configuration is needed for an already seeded installation. Run `npm run dev` if services are not running, then open the dashboard.

Fastify resolves this server configuration on every business request. Headers, cookies, query strings and uploaded fields cannot select a different tenant or operator. PostgreSQL row security and configured operator permissions still apply. An inactive/missing operator or tenant returns `503 WORKSPACE_UNAVAILABLE`; there is no fallback to an arbitrary workspace. All visitors share this operator, so audit records identify that operator rather than individual visitors. The existing loopback defaults describe the intended local usage.

Original values, correction history and financial/cloud policy controls are preserved. Private MinIO, PostgreSQL/Redis credentials and authenticated Python internal endpoints still protect infrastructure and service communication; they are separate from the removed user login.

## Implementation inventory

Created:

- `apps/api/src/workspace-context.ts`: trusted server workspace resolution.
- `tests/fixtures/workspace-api.ts`: test-only selection of separately configured API instances; production ignores its selection header.
- `docs/local-workspace.md`: current behavior and validation.

Removed:

- `apps/api/src/auth.ts`
- `scripts/create-token.ts`
- `apps/web/src/app/api/session/route.ts`
- `apps/web/src/app/login/sign-in.tsx`

Modified:

- Root `.env` (ignored), `.env.example`, `package.json`, `package-lock.json`, `scripts/setup-env.mjs`.
- `apps/api/package.json`; API ingestion routes, extraction routes, financial routes, search routes, workflow routes/OpenAPI, workspace routes.
- `packages/core/src/env.ts`, `packages/core/tests/env.test.ts`, `packages/contracts/src/workspace.ts`, `packages/database/src/transactions.ts` (context documentation).
- Web workspace layout, backend proxy, old login redirect, error page, global styles, shell, backend/client/security helpers.
- Ingestion, extraction, workflow, workspace and browser integration cases; financial/search integration tests; extraction fixtures; frontend/workflow/processing-client unit tests.
- README, architecture/ingestion references and historical phase 3/9/10 report notices.

No dependencies were installed. Removed `@fastify/jwt` and its unused transitive dependencies (14 packages removed). No Python dependencies or environments changed. No database migration or application data deletion was needed.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:frontend
npm run test:search
npm run test:financial
npm run test:integration
```

The frontend suite uses isolated PostgreSQL/MinIO/Redis resources and real installed Chrome. It tests direct access, no session cookies, removed session endpoint, browser Origin protection, uploads, processing, search, previews, corrections/audit, reconciliation, mobile layout and server-configured read-only behavior. API tests also cover forged identity headers and missing configured operators. No cloud provider or new model download is required.

Verified results: TypeScript checks and production build passed. Node unit tests: 191 passed. Python tests: 77 passed using the existing interpreter. Full upload/workflow/workspace/browser suite: 81 passed, including 13 real Chrome cases. Search integration: 19 passed. Financial integration: 20 passed. Running-service integration: 8 passed. Total: 396 passing tests across these suites. The added missing-operator test initially reused an administrator fixture UUID; it was corrected to an absent UUID and the full 81-test suite rerun successfully.

Live checks without credentials: dashboard 200, `/api/v1/me` 200, old `/login` 307 to `/`, removed `/api/session` 404. Root `.env` remains ignored with mode 0600. A scan of current web static artifacts and API/web source found no configured secret values. User-login removal acceptance checks passed. Individual visitor attribution is unavailable by design; all actions use the configured workspace operator.
