# Phase 4: Python document-processing engine

Implemented and verified on 2026-11-15. This phase adds source extraction/OCR and integrates it into the existing document worker. Invoice AI extraction, arithmetic validation, embeddings and reconciliation remain later phases.

## Implemented

The engine processes PDF pages individually, uses PyMuPDF digital text/word coordinates where usable, detects sparse/scanned pages and renders only fallback pages for OCR. Blank rendered pages skip Tesseract. Line-based digital PDF tables use PyMuPDF's existing table detector, so pdfplumber is not required by this implementation. Individual page failures become explicit error records and do not discard good neighboring pages. Encrypted PDFs are rejected; repairable PDFs retain PDF_REPAIRED warnings and invalid/corrupted containers return safe errors.

JPG/JPEG/PNG and every TIFF frame pass through EXIF orientation correction, grayscale, denoising, CLAHE contrast, detected skew correction and conditional adaptive thresholding. Tesseract OSD corrects orientation when confident. OCR preserves word confidence, boxes mapped back through preprocessing, frame/page indices and preprocessing metadata. Image boxes refer to the EXIF-corrected source image; original dimensions/orientation remain in evidence. PDF OCR boxes use unrotated page coordinates in PDF points. Low-confidence/undetected text and missing language data produce warnings or explicit errors, never invented text.

XLSX uses read-only openpyxl workbooks in formula and data-only modes, with external links and VBA retention disabled. Every worksheet, including hidden sheets, is read. Cells retain A1 references, row/column, source value/type, formula and cached result when present. XLS uses on-demand xlrd plus nonexecuting BIFF formula-token decoding, retaining raw tokens when text cannot be recovered. No formula, macro, external link or PDF script is evaluated. Numeric source values are serialized as strings; no financial arithmetic runs.

CSV detects BOM/UTF-8 or infers an encoding from a bounded sample, detects comma/semicolon/tab/pipe delimiters, and streams records. Blank cell values become null; literal NA-like strings remain source text. Empty/ragged/invalid/binary content is rejected. Inferred encodings are explicitly flagged. Ingestion inspection and processing share the same CSV reader so accepted dialects agree.

## Canonical representation and bounded artifacts

The common manifest has schema_version, processor_version, tenant/document/run IDs, original storage/hash/size/type references, document_type=unknown, status, page/error counts, worksheet summaries, warnings and private shard references. No invoice classification is guessed.

Compressed JSONL records use the shared envelope schema_version, tenant_id, document_id and run_id, followed by one of:

| Record | Content |
| --- | --- |
| page | Logical PDF page/image frame/worksheet/CSV source; page number, text, blocks, extraction method, dimensions, coordinates, confidence, source references, warnings/error |
| worksheet_rows | Bounded cell batch linked to its logical page/worksheet; row range and cells with value/formula/cache/source coordinates |
| source_error | An error linked to a previously emitted logical page, such as a worksheet failing after some good row batches |

Worksheet/CSV pages are headers, with empty page text; their cells live in streamed row records and database cell blocks. Consumers must read the associated row records, rather than treating the empty header as an empty worksheet. Missing cached formula values remain null. Unsupported formula text stays null with preserved attributes/tokens and FORMULA_TEXT_UNAVAILABLE.

Each shard holds at most 50 records and 4 MiB uncompressed data; individual records are capped at 2 MiB. Cell batches hold at most 500 cells. Output is capped at 512 MiB uncompressed/document, with image/archive/file/page limits inherited from inspection. An oversized individual page record becomes an explicit error page; a source batch that cannot be represented becomes a source_error. Values are not silently truncated. Embedded null characters that PostgreSQL cannot store are visibly replaced with U+FFFD and recorded as SOURCE_NULL_CHARACTER_REPLACED; the original file remains available privately.

Source data is downloaded to a private temporary directory with byte/hash verification. Disposable child processes use the exact existing interpreter, enforce a whole-parser deadline, and write gzip shards to disk without collecting the document in memory. POSIX executions have a separate process group so timeout cleanup also terminates OCR descendants. Tesseract has a separate per-page timeout. Files upload sequentially to private object storage; a manifest is written last as the completion marker. Interrupted artifact uploads remain under the persisted document prefix and are not exposed without a manifest. Automatic abandoned-run retention cleanup is not implemented.

Storage layout:

```text
tenants/TENANT_UUID/documents/DOCUMENT_UUID/source.EXT
tenants/TENANT_UUID/documents/DOCUMENT_UUID/processing/RUN_UUID/manifest.json
tenants/TENANT_UUID/documents/DOCUMENT_UUID/processing/RUN_UUID/part-00000.jsonl.gz
```

## Internal APIs and worker integration

All /internal routes require Bearer PROCESSOR_INTERNAL_TOKEN before request-body parsing. No untrusted URL/local filesystem path is accepted. Source keys must match the tenant/document original and the configured bucket. Process JSON bodies are capped at 16 KiB; inspection retains its separate multipart limit.

| Method/path | Behavior |
| --- | --- |
| GET /health, /health/ready | Existing process liveness/readiness contracts |
| GET /internal/capabilities | Tesseract executable/version, installed/requested/active/missing languages, OSD availability; embeddings explicitly not implemented |
| POST /internal/process | Validated source reference plus tenant/document/run UUIDs; bounded synchronous processing; returns the small manifest, never all document text |
| GET /internal/artifacts/TENANT_UUID/DOCUMENT_UUID/RUN_UUID/manifest.json | Validated completed manifest from the private bucket |
| GET /internal/artifacts/TENANT_UUID/DOCUMENT_UUID/RUN_UUID/part-NNNNN.jsonl.gz | Streaming gzip shard listed by that manifest; attachment response |
| POST /internal/embeddings | Explicit 501 EMBEDDINGS_NOT_IMPLEMENTED; reserved for the later embedding phase |

Processing requests have this shape; example names represent actual UUID/reference fields, not literal input values:

```text
schema_version: 1
tenant_id, document_id, run_id: UUID
source:
  bucket: configured S3_BUCKET
  key: tenants/{tenant_id}/documents/{document_id}/source{extension}
  sha256: lowercase 64-character hash
  size_bytes: positive original byte count
  extension: supported lowercase extension
```

The existing BullMQ document job now performs stored-byte verification followed by authenticated Python processing. New jobs identify pipeline_version=document-v1; the transport job type remains ingest. There is no second in-memory queue or permanent Python status database. Public GET /v1/documents/:id/status reads authoritative PostgreSQL job/document state. Two worker consumers match two Python processing slots; excess processing requests return retryable PROCESSOR_BUSY.

The worker validates manifest identities/storage references, sequential shard keys, response limits, compressed SHA-256/length, bounded decompression and every record using Zod. It then appends document_pages/document_blocks in bounded, fenced tenant transactions. Every source reference points to the original and artifact/line. Worksheets preserve cell/formula/cache evidence in source_reference.cell. A replay of a succeeded database job performs no new processing or evidence inserts.

An execution heartbeat renews the existing 180-second lease every 30 seconds. A retry creates another source_version and run, preserving prior snapshots. The successful processing checkpoint in documents.metadata.processing and processing_jobs.checkpoint identifies sourceVersion, runId and manifestKey. Readers must use that active version and not combine partial failed attempts. Good pages remain preserved when other pages fail. Final document states are processed, partially_processed or failed. All-failed pages produce a failed job with retained artifacts/evidence; transient transport/storage failures use the existing bounded retries/backoff. The document remains unknown rather than becoming a fabricated invoice result.

No new migration is necessary: the existing five migrations already provide evidence tables, states, metadata, checkpoints, tenant policies and fenced leases. Historical successful ingested records are not automatically backfilled. The other four stage queues remain registered without artificial consumers/jobs.

## Run and configuration

On this configured checkout:

```bash
npm run setup:env
npm run processor:doctor
npm run dev
```

For a fresh checkout with the same existing interpreter:

```bash
npm ci
npm run setup:env
uv pip install --python "/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python" -r services/document-processor/requirements-test.txt
npm run infra:up
npm run db:setup
npm run dev
```

Run only Python with npm run dev:processor. Build all applications with npm run build, then run npm start. Upload through the existing [REST API examples](ingestion.md); the worker processes accepted files automatically. Internal APIs are for trusted services, not browser clients. Existing JWT/MinIO/antivirus configuration remains applicable.

| Environment setting | Default / behavior |
| --- | --- |
| PYTHON_EXECUTABLE | Existing `/Users/sakibsmacbookm5/Documents/Python work/.venv/bin/python` |
| PROCESSOR_INTERNAL_TOKEN | Existing generated secret; required for all internal endpoints |
| PROCESSING_TIMEOUT_SECONDS | 600 whole-parser deadline, validated 30–3600 seconds by Node |
| OCR_LANGUAGES | eng+ben; selects installed requested languages and reports missing packs |
| OCR_RENDER_DPI | 200 for scanned PDF rendering |
| OCR_PAGE_TIMEOUT_SECONDS | 45 for Tesseract text extraction; OSD limited to min(10, page timeout) |
| TESSERACT_CMD | Optional executable override; default discover on PATH |

The source download has a separate 60-second budget, S3 operations use bounded socket timeouts, artifact upload checks an overall parser-timeout-plus-90-second budget, and the worker HTTP deadline is parser-timeout-plus-120 seconds. Slots/timeouts are resource controls, not an OS security sandbox. The shared local .env remains for loopback development; production must isolate administrative/runtime/storage secrets and supply suitable TLS/authentication.

Tesseract was absent initially. Homebrew installed 5.5.4 with eng/osd data. Bangla ben is currently missing and is reported by processor:doctor and OCR warnings. Install appropriate language data through the system package manager; Homebrew's optional tesseract-lang installs additional languages. Restart/recheck capabilities after installation. No Bangla quality claim is made. The service can still process digital content and English OCR; when no requested pack is present, the affected OCR page fails explicitly.

## Dependencies installed

UV used the exact existing interpreter. No environment was created, synchronized, deleted or replaced, and no existing Python package was upgraded/removed.

| New direct Python package | Version |
| --- | --- |
| pytesseract | 0.3.13 |
| opencv-python-headless | 5.0.0.93 |
| openpyxl | 3.1.5 |
| boto3 | 1.44.3 |

New Python transitive dependencies: botocore 1.44.3, et-xmlfile 2.0.0, jmespath 1.1.0, s3transfer 0.19.3. Existing NumPy 2.5.3 and charset-normalizer 3.5.2 are now explicitly pinned because this implementation imports them. Existing PyMuPDF, Pillow, xlrd, defusedxml, FastAPI and test dependencies were reused. pandas/pdfplumber were not installed because the implemented streaming readers/table detector do not require them. No new npm dependency or AI/embedding model was installed.

System dependency: Tesseract 5.5.4. Homebrew also installed its 33 missing native prerequisites: brotli, libpng, freetype, fontconfig, glib, xorgproto, libxau, libxdmcp, libxcb, libx11, libxext, libxrender, lzo, pixman, cairo, graphite2, icu4c@79, harfbuzz, giflib, jpeg-turbo, webp, lz4, zstd, libtiff, little-cms2, openjpeg, leptonica, libb2, libarchive, fribidi, libdatrie, libthai and pango. Homebrew upgraded libunistring 1.4.2→1.5, pcre2 10.47_1→10.49 and xz 5.8.3→5.8.4 as required native dependencies. These are system changes, separate from the preserved Python environment.

## Files created

```text
apps/worker/src/processing.ts
packages/contracts/src/processing.ts
services/document-processor/src/document_processor/models.py
services/document-processor/src/document_processor/csv_reader.py
services/document-processor/src/document_processor/ocr.py
services/document-processor/src/document_processor/processors.py
services/document-processor/src/document_processor/engine.py
services/document-processor/tests/create_processing_fixtures.py
services/document-processor/tests/test_processing.py
services/document-processor/tests/evaluate_processing.py
tests/unit/processing-client.test.ts
docs/evaluation/processing-synthetic.json
docs/phase-4-document-processing.md
```

## Files modified

```text
.env.example
package.json
scripts/python.mjs
packages/contracts/src/index.ts
packages/core/src/env.ts
apps/api/src/ingestion/repository.ts
apps/worker/src/ingestion.ts
apps/worker/src/app.ts
services/document-processor/requirements.txt
services/document-processor/src/document_processor/main.py
services/document-processor/src/document_processor/inspection.py
tests/ingestion/ingestion.test.ts
README.md
docs/ingestion.md
docs/database-schema.md
```

The ignored .env received four missing configuration defaults while preserving all existing values/credentials and mode 0600. SQL migrations, frontend source, Docker configuration, parent Python project configuration and package-lock.json were preserved. Generated fixtures and build output are temporary/ignored. Earlier-phase source remains untracked in this repository; no commit or remote publication was created.

## Tests and actual measurements

```bash
npm run typecheck
npm test
npm run test:database
npm run test:ingestion
npm run evaluate:processor
npm run build
```

With Docker infrastructure and all four applications running, also run npm run test:integration.

| Check | Actual result |
| --- | --- |
| Strict TypeScript checks | Passed |
| Node unit tests | 36 passed, 0 failed |
| Python tests in existing environment | 60 passed, 0 failed; five third-party SWIG deprecation warnings |
| Database schema/security/rollback regression | 37 passed, 0 failed |
| Real ingestion/processing integration | 25 passed, 0 failed |
| Live four-application/infrastructure integration | 8 passed, 0 failed |
| Production builds including Next.js | Passed |
| Total automated tests | 166 passed, 0 failed |

Tests exercise every supported extension, real Tesseract text/confidence/boxes, mixed digital/scanned/blank PDFs, digital table extraction, TIFF frames, EXIF rotation, skew preprocessing, all Excel worksheets/formulas/caches/missing cells/Bangla source strings, CSV delimiters/encodings/streaming, missing Tesseract/languages, encrypted/corrupted PDFs, page failures, a hard child timeout, output caps and a 1,000-page PDF split into 20 bounded shards. Client tests reject cross-tenant manifests/record references, substituted keys, tampering and decompression overflows. Real worker tests verify HTTP processing, private authenticated artifact retrieval, PostgreSQL source evidence, successful replay idempotency and existing queue failure recovery. Disposable integration resources are cleaned up.

One repeated integration run was interrupted by the Mac's idle sleep and returned an inspector timeout during a page-limit assertion. System power logs confirmed the sleep interval; the uninterrupted rerun after waking passed all 25 tests in about 17.5 seconds. The intentionally unavailable-storage test also emits an AWS SDK streaming warning while its recovery assertions pass.

Final infrastructure checks confirmed PostgreSQL, Redis and MinIO healthy, with the same five applied migrations. A source scan of 108 Git-visible files found no configured secret values or trailing whitespace; .env is ignored with mode 0600. Temporary verification application processes were stopped afterward; Docker infrastructure remains running.

The evaluation command wrote [processing-synthetic.json](evaluation/processing-synthetic.json) from actual Tesseract execution: eight clean synthetic English OCR pages, normalized word error rate 0.0 and character error rate 0.0. The report includes recognized/reference text, source hashes, per-page edit counts/confidence, Tesseract/language identity and normalization rules. The eight pages reuse the same printed fixture across formats; these measurements are a reproducible smoke benchmark, not representative real-document or Bangla accuracy. No peak-RSS benchmark was run; the 1,000-page test verifies the shard/batch contract and completed output.

## Limitations and acceptance

- ben data is missing locally; English OCR was evaluated, Bangla OCR was not. Existing digital/worksheet Bangla Unicode is preserved independently of OCR language data.
- Digital text usability, orientation/skew detection and table finding are heuristics. Handwriting, complex layouts, image-only table structure, noisy/low-resolution scans and mixed page overlays need representative evaluation/manual review. Missing/low-confidence evidence stays flagged; text is not invented.
- Original formula spelling is retained for XLSX ordinary formulas. Some BIFF/shared/array/data-table formulas cannot be reconstructed as text: raw tokens/attributes and uncertainty flags remain. No formula is calculated; cached results can be absent or stale.
- Encoding inference can be ambiguous and is flagged. CSV supports comma/semicolon/tab/pipe with strict consistent row width; files outside the accepted limits require a deliberate configuration/reader extension.
- A single-page/row output cap may yield an explicit error instead of complete extraction. The process boundary/timeouts do not provide an OS-level sandbox, and extreme files still need production resource isolation.
- Failed/retried snapshots and private artifact runs are retained. Automatic retention, historical ingestion backfill and a public terminal-job reprocessing endpoint remain later work. Consumers must select the active successful source version.
- Python status is deliberately not stored in Redis or an in-memory permanent registry. PostgreSQL jobs/documents remain authoritative. No frontend upload/results UI or public artifact-download endpoint was added.
- Embedding generation explicitly returns 501 until its requested later phase. Invoice AI extraction, financial validation and reconciliation are not implemented.

The requested processing-phase acceptance checks passed, with the missing Bangla pack and unsupported/uncertain cases explicitly reported. The existing Python Work interpreter/environment is preserved, internal communication is authenticated, outputs are private, and source evidence is versioned in PostgreSQL. Stop after this phase.

Implementation references: [PyMuPDF text and tables](https://pymupdf.readthedocs.io/en/latest/recipes-text.html), [openpyxl formula/data-only behavior](https://openpyxl.readthedocs.io/en/3.1/tutorial.html), and [official Tesseract installation/language guidance](https://github.com/tesseract-ocr/tessdoc/blob/main/Installation.md).
