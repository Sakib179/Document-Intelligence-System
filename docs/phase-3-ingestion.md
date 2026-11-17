> Historical phase report: user sign-in and access tokens were subsequently removed. See [current local workspace behavior](local-workspace.md).

# Phase 3: document upload, storage and BullMQ

Completed and verified locally on 2026-11-15. This report covers ingestion only. OCR, AI extraction, financial validation, search, invoice duplicate detection and an upload frontend are not implemented in this phase.

## Implemented behavior

- Authenticated Fastify multipart uploads accept PDF, JPG/JPEG, PNG, TIF/TIFF, XLSX, XLS and CSV, including multiple files. Successful batches return HTTP 202 and a batch Location.
- Streaming limits, safe filenames, SHA-256, extension/MIME checks and local content/structure inspection run before storage. PDF pages, image frames and worksheets are counted. CSV is validated as text/CSV because it has no magic signature.
- Private MinIO writes use the AWS S3 SDK with known length, checksum, canonical MIME and tenant/document metadata. No public object URLs are returned.
- PostgreSQL stores tenant-scoped upload reservations, document metadata, idempotency state and durable jobs. Duplicates remain separate records with same-tenant hash hints.
- A versioned migration adds a transactional outbox to processing_jobs. A separately restricted dispatcher login can claim/ack fenced leases without reading business tables directly. Stable BullMQ IDs, bounded retries, exponential backoff and database execution leases recover queue outages, lost publication acknowledgments and missing Redis jobs.
- All five requested stage queues are registered. The document consumer verifies stored byte length, metadata and recomputed SHA-256, then atomically records ingested or failed. No later-stage work is simulated.
- Tenant-aware list, detail, batch and processing-status APIs use signed local bearer tokens, current database membership and forced row security. Runtime processes use restricted database roles.
- An antivirus interface supports disabled/not_scanned and ClamD INSTREAM modes. Enabled scanning fails closed on connection/protocol/timeout errors.

API details, configuration defaults, recovery semantics and error codes are in [ingestion.md](ingestion.md). Schema/rollback details are in [database-schema.md](database-schema.md).

## Files created

```text
apps/api/src/auth.ts
apps/api/src/ingestion/files.ts
apps/api/src/ingestion/repository.ts
apps/api/src/ingestion/routes.ts
apps/worker/src/app.ts
apps/worker/src/ingestion.ts
apps/worker/src/outbox.ts
packages/contracts/src/ingestion.ts
packages/core/src/antivirus.ts
packages/core/src/errors.ts
packages/core/src/queues.ts
packages/database/migrations/0005_ingestion_outbox.sql
scripts/create-token.ts
services/document-processor/src/document_processor/inspection.py
services/document-processor/tests/create_ingestion_fixtures.py
services/document-processor/tests/test_inspection.py
tests/ingestion/ingestion.test.ts
tests/unit/antivirus.test.ts
tests/unit/ingestion-files.test.ts
docs/ingestion.md
docs/phase-3-ingestion.md
```

## Files modified

```text
.env.example
package.json
package-lock.json
apps/api/package.json
apps/api/src/app.ts
apps/worker/package.json
apps/worker/src/main.ts
apps/worker/src/processor.ts
packages/contracts/src/index.ts
packages/core/package.json
packages/core/src/env.ts
packages/core/src/connections.ts
packages/core/src/health.ts
packages/core/src/index.ts
packages/core/tests/env.test.ts
packages/database/src/index.ts
packages/database/src/admin.ts
scripts/database.ts
scripts/setup-env.mjs
services/document-processor/requirements.txt
services/document-processor/requirements-test.txt
services/document-processor/src/document_processor/main.py
tests/database/schema.test.ts
tests/unit/worker.test.ts
README.md
docs/database-schema.md
```

The ignored root `.env` was also updated with missing local configuration/random secrets while preserving existing values and mode 0600. Migrations 0001–0004, frontend source and Docker infrastructure configuration were preserved. Build outputs, caches and generated test fixtures are ignored/temporary. The repository's earlier-phase files were already untracked; this inventory identifies this phase's changes without claiming a commit was created.

## Dependencies

New npm direct dependencies: `@fastify/multipart@10.1.8` and `@fastify/jwt@10.2.7` in the API. Existing `@aws-sdk/client-s3@3.1169.0` is now explicitly declared by API/worker; existing `bullmq@5.81.5` is explicitly declared by core. Lockfile updated; installation reported zero audit vulnerabilities. Transitive dependencies are recorded in package-lock.json.

Installed through UV into the existing interpreter only:

| Package | Version | Purpose |
| --- | --- | --- |
| PyMuPDF | 1.28.2 | PDF structure/page inspection, without extraction/inference dependencies |
| xlrd | 2.0.2 | Legacy XLS structure/worksheet inspection |
| defusedxml | 0.7.1 | Defensive OOXML parsing |
| xlwt | 1.3.0 | Test-only real XLS fixture creation |

Existing FastAPI, Uvicorn, Pydantic, Pillow, multipart, HTTPX and pytest installations were reused. No packages were upgraded/removed from the existing environment, no model was downloaded and no virtual environment was created. The exact interpreter remains `/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python`.

## Commands to run

For this already-configured checkout, infrastructure and migration 0005 are installed. Start the applications with:

```bash
npm run dev
```

For a fresh checkout using the same existing Python environment:

```bash
npm ci
npm run setup:env
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-test.txt
npm run infra:up
npm run db:setup
npm run dev
```

For an existing database without adding seed fixtures, use `npm run db:migrate` instead of `db:setup`. Do not replace existing database credentials. For built applications, run `npm run build` then `npm start`.

In another terminal, obtain a local seed reviewer's token and upload an actual file:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
curl -i http://127.0.0.1:3001/v1/upload-batches \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Idempotency-Key: local-invoices-batch-001" \
  -F "files=@/absolute/path/invoice.pdf;type=application/pdf"
curl http://127.0.0.1:3001/v1/documents -H "Authorization: Bearer $API_TOKEN"
```

Replace the example path. Token output is a credential; keep it out of source control/shared logs. Supply repeated files parts for multiple documents. API/worker/Python/web listen on loopback ports 3001/3002/8000/3000 respectively. The local README includes all service endpoints.

## Actual verification results

The combined command below exited 0:

```bash
npm run typecheck && npm test && npm run test:database && npm run test:ingestion && npm run build
```

With `npm start` running all four applications against local Docker infrastructure, `npm run test:integration` also exited 0.

Final migration status confirmed 0001–0005 applied; PostgreSQL, Redis and MinIO were healthy. A scan of 95 Git-visible files found no configured secret values or trailing whitespace. The root .env is ignored with mode 0600. Verification application processes were stopped afterward; Docker infrastructure remains running.

| Check | Actual result |
| --- | --- |
| Strict TypeScript checks | Passed |
| Node unit tests | 30 passed, 0 failed |
| Python tests in existing interpreter | 33 passed, 0 failed; five third-party SWIG deprecation warnings |
| PostgreSQL schema/rollback/security tests | 37 passed, 0 failed |
| Ingestion integration tests | 23 passed, 0 failed |
| Running foundation/service integration checks | 8 passed, 0 failed |
| Production application builds, including Next.js | Passed |
| Total automated tests | 131 passed, 0 failed |

The ingestion suite uses a disposable real PostgreSQL database/private MinIO bucket/Redis prefix, the actual Python inspector, real format fixtures and Fastify HTTP requests. It verifies all supported extensions, 202 acceptance, invalid extensions/signatures/MIME, malformed/encrypted files, duplicate preservation, oversize/raw-request/file-count/page limits, atomic multiple uploads, idempotency/concurrency, tenant isolation, private exact bytes, antivirus unavailability, storage recovery, actual Redis connection failure/recovery, lost publish acknowledgment/missing Redis jobs, exhausted dispatch retries, bounded processing retries and same-size checksum tampering. Temporary test resources are removed. A storage-failure test intentionally triggers an AWS SDK non-retryable-stream warning; its assertions passed.

Database tests include all five migrations down/up, restricted roles and atomicity. Live checks verify PostgreSQL/pgvector operations, authenticated Redis, authenticated MinIO upload/read/delete plus anonymous denial, API/worker/Python health, a real operational BullMQ round trip and Next rendering/health. These are functional/security/recovery measurements, not invented extraction-quality metrics.

## Manual configuration and limitations

- Local secrets are generated in ignored `.env`; retain the existing interpreter and database passwords. Configure desired file/page/timeout/retry limits there. Newly required secrets are API_JWT_SECRET, PROCESSOR_INTERNAL_TOKEN and POSTGRES_DISPATCHER_PASSWORD.
- ANTIVIRUS_MODE defaults to disabled and records not_scanned. To scan, run an existing private ClamD service with current signatures and adequate stream limits, then configure ANTIVIRUS_MODE=clamav, CLAMAV_HOST/PORT/TIMEOUT_MS. Controlled protocol tests and unavailable-service behavior passed; no real malware/signature evaluation was run and no daemon was installed.
- Local administrative JWT issuance is functional; public login/SSO/refresh enrollment is not provided. Production needs trusted identity integration, TLS and separate migration/runtime/storage secret delivery. The shared local .env is not production secret isolation.
- Abandoned staged/failed object uploads retain durable PostgreSQL ownership references. Same-key retries recover them; automatic retention/garbage collection is not implemented. Inspect records/leases before administrative removal.
- Encrypted documents, malformed/ragged CSV, unsupported legacy CSV encodings, excessive archive/image inflation and macro-bearing XLSX containers are rejected. Inspection runs in timeout-bounded child processes, but it is not an OS sandbox.
- Terminal job retry through a public reprocessing endpoint is a later phase. PostgreSQL retains failure/error history; retries within this phase are bounded automatically.
- The frontend remains the existing health overview. This phase provides ingestion REST APIs and local operational authentication. All five stage queues exist, with only document ingestion and operational probes consumed.
- No OCR, text/cell extraction, invoice segmentation/extraction, invoice duplicate classification, arithmetic validation, reconciliation, embedding inference or semantic search was added.

## Acceptance

All ingestion-phase acceptance checks passed, including valid/invalid/multiple/duplicate/oversize uploads and queue failure, private storage, authoritative database state, transactional dispatch, tenant isolation and the preserved Python environment. Secrets are excluded from source files and Git; no commit or remote publication was performed. Stop here and wait for the next phase instruction.
