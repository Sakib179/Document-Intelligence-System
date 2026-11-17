# Phase 7: financial validation and cross-document reconciliation

Implemented on 2026-11-16. This phase adds deterministic financial validation, duplicate candidates and cross-document comparison against existing extracted invoice records. It does not perform model inference, alter reported amounts, approve invoices or build a new frontend workflow.

## Architecture and persistence

The new `@doc/finance` workspace contains pure decimal, validation, duplicate and reconciliation functions. Shared Zod contracts validate financial inputs, rules and reports. The Fastify API exposes bounded synchronous operations; PostgreSQL repeatable-read transactions publish snapshots and issues atomically. No Redis financial state, additional service or unimplemented validation queue job is introduced. Earlier ingestion/extraction workers retain their existing behavior.

Migration 0008 adds:

- `invoices.financial_terms`, captured by the existing original-value/correction/audit mechanism.
- Append-only `financial_validation_runs`, with tenant/document/invoice foreign keys, requester, request key, engine version, input digest, rules, original/current input and duplicate snapshots, financial status and checks/issues.
- Financial run/severity/manual-review links on validation issues.
- Engine version, financial_status, request key, hash and input snapshot on reconciliation_runs; financial severity/manual-review fields on reconciliation_items.
- Database guards for source/report identity, matching report/status metadata, immutable calculated values and finalized deterministic results. Existing manual issue-resolution fields remain editable with actor/reason history.
- Nonunique duplicate/version lookup indexes. No invoice-number or file-hash uniqueness constraint is added.

Concurrent same-key requests are serialized and bounded serialization/key-race retries preserve idempotency. A failed issue insert rolls back the run and audit events together. Later corrections create new validation/reconciliation snapshots under new keys rather than overwriting previous results.

Financial outcomes are `VALID`, `WARNING` and `REVIEW_REQUIRED`. They are independent of document/job processing status and human review_status. A successfully completed reconciliation may have processing_status=succeeded and financial_status=REVIEW_REQUIRED. Neither validation nor reconciliation updates source amounts, document processing status or human approval.

History reads compare saved input with current invoice/line revisions and values, duplicate context and engine version. A changed source or newly discovered duplicate makes a validation stale; the invoice history API then returns financial_status=REVIEW_REQUIRED. Reconciliation similarly compares its current active invoice versions and source coverage. Immutable historical results retain their original statuses and expose `is_current=false` rather than being rewritten. Resolving an issue does not alter the original calculation outcome.

## Deterministic rules

All monetary arithmetic uses a private decimal.js constructor with 80-digit precision. Decimal strings never pass through JavaScript Number, parseFloat or toNumber. Integer counts, match scores and currency precision metadata are ordinary nonfinancial numbers. Monetary outputs and original/current history values remain strings. The engine version includes the Node ICU version used for currency metadata, so an engine/runtime metadata change invalidates an old current-status claim.

The default mandatory header fields are invoice_number, invoice_date, supplier_name, subtotal, tax, total and currency. Customer name is configurable. Default mandatory line fields are description, quantity, unit_price and line_total. Missing values, malformed dates, unsupported/ambiguous currency codes, nondecimal/NaN/infinite/exponent/grouped numeric strings, inappropriate negative values, zero quantities and invalid fractional tax rates produce structured issues. Signed records and zero quantities can be enabled explicitly in recorded rules. Fractional nonzero quantities are supported.

Calculations check:

```text
Line amount = Quantity × Unit price
Subtotal = Sum of applicable line amounts on the stated subtotal basis
Net-basis expected total = Subtotal + Tax + Charges - Discounts - Withholding
Gross-basis expected total = Subtotal + Charges - Discounts - Withholding
```

Gross subtotal already includes tax. Tax is not added twice. Explicit inclusive/exclusive/exempt treatment and net/gross bases control the checks; unknown or contradictory treatment requires review. Line prices and reported line amounts must use the declared line basis. Where explicit rates support conversion, gross lines can be converted to net subtotal amounts, or net lines to a gross subtotal. Missing conversion rates skip that check and create a review issue.

`tax_scope=reported` checks total arithmetic using the reported tax amount without inventing a jurisdiction-specific rate or taxable base. When the source establishes that all tax comes from the listed lines, `tax_scope=line_items` additionally checks line-derived tax. Net line tax uses amount × fractional rate; gross line tax uses amount - amount/(1+rate). Per-line or aggregate tax rounding is configurable. Mixed explicit line rates are supported. Nonzero header adjustments with an unestablished taxable scope are flagged rather than assigned a guessed tax treatment. Exempt treatment requires zero reported tax and zero rates where rates are present.

Unknown charges, discounts and withholding are never silently replaced with zero. Explicit zero amounts and confirmation of adjustment completeness are required for a complete total check. Likewise full line coverage must be confirmed before a subtotal sum is considered complete. The current extraction schema does not establish those facts; its invoices initially require financial review until a reviewer supplies confirmed terms. Excluded line IDs are explicit, auditable and checked for existence; excluded lines remain represented and retain their own numeric/line checks.

Currency metadata uses Node's ICU/Intl currency digits, with explicit support for CLF/UYW indexed units. Default tolerance is one minor unit. Examples are USD/BDT 0.01, JPY 1, KWD 0.001 and CLF 0.0001. A nonzero difference within tolerance is WARNING and is preserved; a larger discrepancy requires review. Rules support half-up/half-even rounding, per-currency precision/tolerance overrides, summing printed line amounts or rounding aggregate products, and per-line/aggregate tax rounding. Original amounts are never rounded in place.

References: [decimal.js API](https://mikemcl.github.io/decimal.js/), [ECMA-402 CurrencyDigits](https://tc39.es/ecma402/#sec-currencydigits). Currency defaults are technical rounding conventions, not tax-law or cash-settlement rules.

An issue has the requested structure plus source/related-record evidence:

```json
{
  "code": "TOTAL_MISMATCH",
  "field": "total",
  "expected": "11500.00",
  "actual": "12000",
  "severity": "high",
  "manual_review_required": true,
  "related_document_id": null,
  "related_invoice_id": null,
  "evidence": {}
}
```

Reports list performed, passed, failed, warning and skipped checks. Missing prerequisites cannot silently turn a skipped required calculation into VALID. High-severity or manual-review issues yield REVIEW_REQUIRED; only permitted rounding differences yield WARNING; complete consistent configured checks yield VALID. Legacy issue-table severities map high/medium/low to error/warning/info, while the report and new financial_severity column retain the requested vocabulary.

## Duplicates and reconciliation

Exact duplicate detection compares stored SHA-256 values within the authenticated tenant. Business candidates compare normalized supplier and invoice number, valid date, currency and exact decimal total. Supplier+invoice-number agreement is reviewable even when other fields conflict; otherwise four agreeing signals are needed. Amount agreement only counts in the same currency. The result records matched signals and related document/invoice IDs. Weak supplier/amount coincidences are not sufficient. Another extraction version of the same candidate is excluded from business duplicate matching. Legitimate duplicates remain stored and are never automatically rejected.

PDF/PDF and PDF/spreadsheet reconciliation select the newest invoice snapshot for each candidate in the active understanding version. XLSX, XLS and CSV records are supported. Current records are compared for invoice number, supplier, date, subtotal, tax, total, currency and line items. Both original/current values and source evidence are saved. Spreadsheet worksheet/cell anchors remain on the right-hand evidence; PDF page references remain on the left. There is no currency conversion.

Matching uses deterministic identity signals and requires an unambiguous one-to-one best candidate on both sides. Ties and conflicting repeated identities remain explicit ambiguous records. Unmatched invoices from both sources remain in the report. Exact repeated lines are compared as multisets, retaining multiplicity; otherwise unique descriptions identify comparable lines. Ambiguous repeated descriptions are not arbitrarily paired. Quantities/rates compare exactly, while monetary comparisons use the recorded currency tolerance.

Unresolved candidates, missing active understanding, missing extracted invoice candidates, partial/rejected source processing, source extraction warnings and unavailable/incomplete line evidence require review. A spreadsheet containing only a header summary cannot establish a complete line-item match. A reconciliation VALID means the compared source records agree under the selected comparison rules and coverage checks; financial arithmetic validation remains the separate invoice validation operation, and neither outcome is human approval.

## Run commands and APIs

From the repository root:

```bash
npm ci
npm run infra:up
npm run db:migrate
npm run dev
```

Migration 0008 is already applied to the local development database. No new environment variables are required. Financial rules are configured per request and saved with each run. The selected Gemini 3.8 Flash/Qwen 3.5 4B settings and cloud policy are unchanged. Financial operations need no model or inference server. No secrets are included in source.

Issue a local token after loading development seeds if needed:

```bash
export API_TOKEN="$(npm run --silent auth:token -- 11111111-1111-4111-8111-111111111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)"
```

Use actual invoice/document UUIDs returned by earlier extraction APIs. Readers may view results; reviewers/admins may create runs and correct terms.

```bash
curl http://127.0.0.1:3001/v1/invoices/INVOICE_ID/validations \
  -H "Authorization: Bearer $API_TOKEN"
```

The result includes current invoice facts, revision, financial_status or null when never validated, stale flag and latest run snapshots. `limit` accepts 1–20, default 10. Read the current invoice.revision before an optimistic terms correction. For a source actually confirmed to be tax-exclusive with no additional adjustments and complete line coverage, an example request is:

```bash
curl -X PATCH http://127.0.0.1:3001/v1/invoices/INVOICE_ID/financial-terms \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"revision":1,"reason":"Reviewer confirmed net prices, complete lines and no additional adjustments","terms":{"tax_mode":"exclusive","subtotal_basis":"net","line_amount_basis":"net","tax_scope":"line_items","charges":"0","discounts":"0","withholding":"0","adjustments_complete":true,"line_items_complete":true,"evidence":{"page":1,"note":"Reviewer checked the original invoice"}}}'
```

Replace revision 1 with the actual current revision. Do not submit these declarations without checking the source. Omitted PATCH fields retain their prior values. Stale revisions return 409; every update preserves originals and records its actor/reason/before/after values.

Create or rerun a financial snapshot:

```bash
curl -i -X POST http://127.0.0.1:3001/v1/invoices/INVOICE_ID/validations \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: financial-check-001" \
  -H "Content-Type: application/json" \
  -d '{"rules":{"required_fields":["invoice_number","invoice_date","supplier_name","subtotal","tax","total","currency"],"currency_overrides":{"USD":{"tolerance_minor_units":"0"}}}}'
```

POST returns 201 for a new report, 200 for a replay, the effective Idempotency-Key header and a Location. Reusing a key with changed rules returns 409. Reusing it after source changes returns the same historical run with is_current=false; use a new key for intentional revalidation. Unknown terms still yield a real REVIEW_REQUIRED report rather than a fabricated pass.

Compare two documents, with a PDF on the left:

```bash
curl -i -X POST http://127.0.0.1:3001/v1/reconciliations \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: reconciliation-001" \
  -H "Content-Type: application/json" \
  -d '{"left_document_id":"PDF_DOCUMENT_ID","right_document_id":"OTHER_DOCUMENT_ID","rules":{}}'

curl http://127.0.0.1:3001/v1/reconciliations/RUN_ID \
  -H "Authorization: Bearer $API_TOKEN"
```

Replace placeholders with actual UUIDs. Same-key/same-pair/same-rules requests replay; changing either source or rules under the same key returns 409. Self-comparison and unsupported formats return 400. Cross-tenant IDs are invisible. Reports include both source snapshots, matched/ambiguous pairs, comparisons, structured issues, processing/financial statuses, engine version/hash and is_current.

## Verification and dependencies

```bash
npm run typecheck
npm test
npm run test:database
npm run test:financial
npm run test:ingestion
npm run build
# With built applications running through npm start:
npm run test:integration
```

Observed results are recorded after running these commands; finance tests use explicit synthetic normalized/extracted records and real PostgreSQL/REST, without claiming model inference or live provider quality:

| Check | Result |
| --- | --- |
| Strict typecheck | Passed |
| Node unit tests | 170 passed, including 62 financial/domain cases |
| Python tests | 60 passed using the existing interpreter |
| Schema/migration tests | 47 passed, including forced RLS and complete eight-migration down/up |
| Financial database/API tests | 20 passed |
| Existing ingestion/extraction integration tests | 39 passed |
| Live PostgreSQL/Redis/private MinIO/API/worker/Python/Next.js checks | 8 passed against the existing running applications |
| Authenticated financial read endpoint | HTTP 200 |
| Production API/worker/Next.js build | Passed |
| Production dependency audit | 0 reported vulnerabilities |

Financial tests cover field policy, invalid strings/signs/quantities/rates, exact large/fractional amounts, line/subtotal/total discrepancies, explicit adjustments, inclusive/exclusive/exempt and mixed-rate-capable arithmetic, unknown assumptions, rounding policies/currencies, duplicates, unmatched/ambiguous records, repeated-line multiplicity, spreadsheet coordinates, original/current preservation and incomplete evidence. Database/API tests cover concurrent request idempotency, tenant/role/input checks, audited corrections, stale financial status, immutable calculations with audited resolution, failed-publication atomicity, PDF/PDF and XLSX/XLS/CSV comparisons, source coverage, request limits, independent schema identity/status constraints and downgrade data preservation.

Python emitted the existing five PyMuPDF/SWIG deprecation warnings. The intentional ingestion storage-disconnection test emits an AWS streaming message while its recovery assertion passes. These are actual regression results, not real-document precision/recall or model accuracy claims.

The six test suites above total **344 passing tests**, with none skipped. PostgreSQL, Redis and MinIO remain healthy on loopback, and all eight migrations are applied. The existing user-run applications were checked without being restarted or stopped. Cleanup found zero remaining disposable test databases, test buckets or test queue keys. A scan of all 155 Git-visible source files found no configured-secret leaks or trailing whitespace; the ignored .env remains mode 0600.

The new workspace declares **decimal.js 10.6.0**, reusing the version already installed for extraction. `npm install --offline --ignore-scripts` linked @doc/finance and updated the lockfile. The database/root declare the local @doc/finance 0.1.0 workspace dependency. No additional third-party library version, Python dependency, system package, inference runtime or model was installed.

The required `python -c "import sys; print(sys.executable)"` still finds no shell alias. The existing interpreter was verified directly as `/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python`. Python Work (.venv) remains unchanged; no environment was created, deleted, replaced or synchronized.

## File inventory

Created:

```text
packages/contracts/src/finance.ts
packages/finance/package.json
packages/finance/tsconfig.json
packages/finance/src/index.ts
packages/finance/src/decimal.ts
packages/finance/src/validation.ts
packages/finance/src/duplicates.ts
packages/finance/src/reconciliation.ts
packages/database/src/financial.ts
packages/database/migrations/0008_financial_validation.sql
apps/api/src/financial/routes.ts
tests/fixtures/finance.ts
tests/unit/financial-validation.test.ts
tests/financial/financial.test.ts
docs/phase-7-financial-validation.md
```

Modified:

```text
package.json
package-lock.json
packages/contracts/src/index.ts
packages/database/package.json
packages/database/tsconfig.json
packages/database/src/index.ts
apps/api/src/ingestion/routes.ts
tests/database/schema.test.ts
README.md
docs/architecture.md
docs/database-schema.md
```

Earlier migration files, model configuration, .env/.env.example, Python services/environment, frontend source and infrastructure configuration were preserved. Build output remains ignored. No commit, push or deployment was performed.

## Manual configuration, capacities and known limits

No financial secrets or new environment settings are needed. Reviewers must confirm applicable tax/amount bases, complete line coverage and actual charges/discounts/withholding before a complete financial pass is possible. Choose any invoice-specific required fields, rounding policy or signed-value exception in the rules request. These are audited assumptions, not automated factual extraction.

Operations are synchronous and bounded to 1,000 lines per invoice, 100 current invoices and 1,000 lines per document for reconciliation. Snapshot/report JSON limits are 8 MiB per validation snapshot/report and 16 MiB per reconciliation snapshot/report; oversized requests return 413 without publishing a partial result. Existing API JSON request bodies are limited to 16 KiB. Database statements retain their existing time budget; financial timeouts return 503. Larger reconciliation sets need a later batched/background orchestration layer. Validation-queue remains reserved and is not presented as an implemented worker.

Matching is conservative normalization and identity matching, without embeddings, fuzzy vendor aliases, FX conversion or inferred associations. Tax rules do not implement every jurisdiction, compound taxes, discount allocation across tax categories or cash-rounding increments. Explicit mixed line rates and the supported calculation conventions are handled; uncertain scopes require review. Currency recognition uses runtime ICU metadata plus the documented indexed units, with recorded version and configurable rounding overrides. Input numbers must already be normalized decimal strings; ambiguous localized forms remain reviewable rather than guessed.

Reconciliation uses invoice records created by prior extraction, not a new direct Excel parser. A summary ledger without complete lines cannot establish line equivalence. Financial VALID means the configured deterministic checks passed on the recorded facts; it is not authenticity, accounting-policy approval or human review. Original extraction metadata remains an immutable account of that earlier phase and is not overwritten to claim later financial approval.

Before rollback, stop writers and export financial_validation_runs, invoice financial_terms and reconciliation input snapshots:

```bash
npm run db:rollback -- --version 0008 --dry-run
```

The actual Down migration removes new financial tables/terms/links. Existing invoices/original_values, issue/reconciliation expected/actual values and audit history remain. Reapplying does not restore removed snapshots or confirmed terms. Prefer forward migrations after real use. The downgrade was exercised only in disposable test databases.

Acceptance criteria passed for this phase's financial engines, persistence, APIs and automated rule/duplicate/reconciliation tests. No later phase was started.
