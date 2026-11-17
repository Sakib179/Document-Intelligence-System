# Phase 2: initial PostgreSQL schema

Completed November 15, 2026 (Asia/Dhaka). Database schema and tooling only; no application processing was implemented.

## Delivered

- All fifteen requested logical tables, plus the migration tool's history table.
- Idempotent pgvector enablement, `vector(1024)`, a partial cosine HNSW index, and a full-text GIN index.
- Composite tenant/document foreign keys, filtering/review/history indexes, required-field and JSON-shape checks, finite numeric domains, and source/evidence constraints.
- Nonunique document-hash and invoice-number indexes: legitimate duplicates remain stored and can be flagged.
- Restricted runtime credentials, forced tenant row security on all business tables, default-deny unscoped queries, and validated transaction-local tenant/actor/reason context.
- Immutable original invoice/line-item snapshots, revision counters, explicit human review decisions, issue-resolution history, and append-only transactional audit events.
- Append-only versioned page/block evidence and immutable finalized extraction results.
- Versioned SQL Up/Down migrations using `node-pg-migrate`, advisory locking, transactional application/rollback, status commands, and an explicit current-version rollback guard.
- Idempotent fictional development seeds and a disposable-database test suite.

The development database is migrated through `0004_indexes`. Existing tenant/document application APIs were not added. The original assignment PDF and existing Python environment were untouched.

## Verification results

| Command/check | Actual result |
| --- | --- |
| `npm run db:setup` | Passed: runtime role provisioned, four migrations applied, development fixtures loaded |
| `npm run db:status` | Passed: all four migrations applied |
| `npm run db:rollback -- --version 0004 --dry-run` | Passed: no schema/history changes committed |
| `npm run test:database` | **37 tests passed**, zero failures |
| `npm test` | **16 Node tests + 6 Python tests passed** |
| `npm run typecheck` | Passed for packages, applications, tools and tests |
| `npm run build` | Passed, including optimized Next.js build |
| `npm run test:integration` | **8 existing live integration tests passed** with restricted PostgreSQL credentials |
| Migration failure test | Passed: intentional DDL/error rolled back without a history entry |
| Full down/up test | Passed in disposable database; vector extension retained |
| Post-test cleanup | Passed: no `di_schema_test_*` databases left; development schema/indexes intact |
| npm dependency resolution audit | Zero vulnerabilities after the scoped glob override |

In total, 67 tests passed across the database and existing suites. The vector tests use synthetic vectors to verify dimensions, cosine distance and actual HNSW plan use. No extraction, OCR, semantic-quality, or financial-evaluation metrics were generated.

Database coverage includes tenant read/write isolation and foreign-key rejection; default-deny access; runtime role privileges; exact decimal storage beyond JavaScript's safe integer range; nullable fields; duplicate recording; bounding boxes, worksheets and source versions; immutable evidence/originals; correction author/reason and optimistic revisions; human review; issue/reconciliation resolution; append-only audit protection; bounded job attempts/idempotency; extraction completion/history; transaction rollback and pooled-context cleanup; vector constraints/search; seed idempotency; migration locking, failure atomicity, dry run and full rollback/reapply.

## Run commands

For a fresh checkout, keep Docker Desktop running and use the existing Python environment:

```bash
npm ci
npm run setup:env
npm run infra:up
npm run db:setup
npm run dev
```

No further manual configuration is needed on the inspected machine. Existing root values are preserved; setup added `POSTGRES_APP_USER` and a randomly generated `POSTGRES_APP_PASSWORD`. On another machine, set the existing Python interpreter path and any changed local infrastructure addresses in ignored `.env`.

For schema changes without seeds:

```bash
npm run db:migrate
npm run db:status
```

For verification, with PostgreSQL running:

```bash
npm run typecheck
npm test
npm run test:database
```

With all applications running, use `npm run test:integration`. Stop development processes before `npm run build`; `npm start` launches the built applications. Temporary application verification processes were stopped after checks; the three infrastructure containers remain running.

## Rollback strategy

Read the [schema reference](database-schema.md) and the migration's Down section, check the head with `db:status`, then dry-run the exact current version:

```bash
npm run db:rollback -- --version 0004 --dry-run
```

Omitting `--dry-run` reverts one latest migration. The command refuses a missing/mismatched version. PostgreSQL wraps the selected migration and its history changes in a transaction. Schema-table rollback deletes records; back up real data and prefer forward fixes. Reapplying migrations does not restore deleted data. The full rollback/reapply test touched only its disposable test database, not the development database. The shared extension and cluster-level runtime login are deliberately preserved by rollback.

## Dependencies installed or changed

| Dependency | Change |
| --- | --- |
| `node-pg-migrate@9.0.0` | New direct dependency of `@doc/database` |
| `glob@14.0.6` | Scoped transitive override for the migration tool's patched dependency resolution |
| `minimatch@11.0.8` | Patched transitive resolution through glob |
| `zod@4.6.7` | Already installed; declared directly by the database package for tenant-context validation |

Other migration-tool transitive packages and exact resolutions are recorded in `package-lock.json`. No Python dependencies, AI models, host Python environments, or infrastructure image versions were added/changed in this phase.

## Files created

| File | Purpose |
| --- | --- |
| `packages/database/migrations/0001_vector.sql` | Extension migration and non-destructive extension rollback |
| `packages/database/migrations/0002_initial_schema.sql` | All fifteen tables, domains, evidence and relational constraints |
| `packages/database/migrations/0003_tenant_security_and_history.sql` | Tenant policies, grants, review/correction/audit triggers |
| `packages/database/migrations/0004_indexes.sql` | Tenant/filter/FK/history, keyword and HNSW indexes |
| `packages/database/seeds/development.sql` | Fictional, idempotent fixtures with isolated tenants and correction history |
| `packages/database/src/admin.ts` | Migration administrator pool, role provisioning, migration/status/seed functions |
| `packages/database/src/transactions.ts` | Transaction lifecycle and validated tenant context |
| `scripts/database.ts` | Database setup/migrate/status/seed/rollback CLI |
| `tests/database/schema.test.ts` | 37 real PostgreSQL tests in a disposable database |
| `docs/database-schema.md` | Schema, relationships, security, data conventions and rollback reference |
| `docs/phase-2-database.md` | This delivery and verification report |

## Files modified

| File | Change |
| --- | --- |
| `.env.example` | Separate runtime database account placeholders |
| `package.json` | Database commands/tests and scoped glob override |
| `package-lock.json` | Pinned migration-tool/dependency resolutions |
| `packages/database/package.json` | Migration/Zod dependencies and separate administrative export |
| `packages/database/src/index.ts` | Runtime-only pool credentials, shared config, transaction exports |
| `packages/core/src/env.ts` | Validate runtime role/password configuration |
| `packages/core/tests/env.test.ts` | Extend valid test configuration with the runtime credential fixture |
| `scripts/setup-env.mjs` | Add missing keys without replacing existing credentials |
| `README.md` | Current setup, schema commands, runtime/admin separation, database tests and documentation links |

Ignored local `.env` was also updated with the two runtime account keys. Generated passwords are not listed here or committed. Compiled outputs and caches remain ignored. No commit or remote push was performed.

## Assumptions and limitations

- Tenant/user identity must come from a trusted authenticated application or worker. Session settings provide scoped database access, not user authentication; possession of the runtime credential remains privileged server access.
- The shared local `.env` contains migration credentials for developer convenience. Deployment must give those credentials only to administrative jobs, not the API/worker runtime.
- Seed documents, hashes, extracted text, invoices and mismatches are deliberately fictional; corresponding MinIO objects do not exist. Seed jobs are not dispatched and no detector/model/reconciler was executed.
- Pages/blocks are immutable versions, while invoice/line-item current fields can be corrected with preserved originals/audit. Reprocessing must create new source versions and extraction runs.
- Financial columns and stored JSONB decimals are exact in PostgreSQL. Use decimal strings and SQL text extraction when serializing history through JavaScript; do not convert financial JSON numeric values through `Number`.
- Optimistic conflict detection requires callers to use `WHERE revision = expected_revision` and check the affected row count. Serializable transaction retries are a caller responsibility.
- Detailed extraction/evidence JSON validation, authentication, processing orchestration, financial calculations, duplicate detection, reconciliation, and search APIs remain future application phases.
- The migration tool tracks version/name ordering rather than file-content checksums. Published migrations must remain immutable; add a new file for a change.
- ANN recall/performance depends on data and filtering; model/configuration compatibility must be enforced in later search code. No performance or quality guarantee is inferred from synthetic index tests.

All requested schema-phase acceptance requirements passed. Work stops after this phase.
