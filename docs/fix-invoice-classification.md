# PDF invoice detection and local extraction recovery

The sample two-page invoice was incorrectly classified as unknown. Its preserved digital text joined the invoice title to an adjacent address (`BangladeshINVOICE`) and placed invoice number/date columns on one line. The detector depended on a standalone title and rejected the date column following the identifier.

Changes:

- `apps/worker/src/understanding/signals.ts`: accept known invoice-date columns following the identifier; distinguish invoice date labels from titles; recognize invoices with independent identifier, date, totals and line-table evidence when title reading order is damaged. Recognize page counters at the end of multi-column footers and preserve payment-reference evidence.
- `apps/worker/src/understanding/engine.ts`: use a matching payment reference to confirm an adjacent, sequential continuation page. A payment reference alone cannot start an invoice; mismatching references do not merge pages.
- `apps/worker/src/extraction/providers.ts`: bounded compatibility retry when the local runtime explicitly rejects constrained output with `501 structured output is unavailable`. The retry supplies concrete invoice/line-item templates derived from the shared Zod schema, rather than a JSON Schema that the small model repeated as its answer. Existing Zod validation and evidence grounding remain mandatory. Unwrap only a single JSON code fence when emitted by an unconstrained runtime. Suppress unnecessary model thinking for extraction; see [Ollama compatibility documentation](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx).
- `apps/worker/src/extraction/prompt.ts`: prompt version `invoice-extraction-v2`, recorded with new runs/attempts. The stored invoice schema and job pipeline remain compatible.
- `tests/unit/understanding.test.ts`, `tests/unit/extraction-providers.test.ts`: regressions covering the layout, continuations, negative examples and local output capability fallback.
- `apps/web/src/lib/extraction-state.ts`: explicit type-import extension for NodeNext type checking.
- Ignored root `.env`: local inference timeout increased from 60 to 180 seconds, within the existing bounded configuration.

No dependencies or models installed. The existing Python environment is unchanged. Gemini cloud processing remains disabled; the document was not sent to a cloud provider. Reprocessing and recovery use new database job/run records, retain original source/history and use the configured workspace audit actor.

Verification:

```bash
npm run test:node
npm run test:ingestion
npm run typecheck
```

201 Node tests passed, including 44 understanding/advisor checks. 68 real PostgreSQL/Redis/MinIO/Python ingestion and workflow integration tests passed. TypeScript checks passed. Replaying the actual normalized PDF now produces one invoice candidate with source pages `[1, 2]`; missing supplier identity during segmentation still requires review rather than being guessed.

Live recovery succeeded: local `qwen3.5:4b` with prompt version 2 produced invoice `INV-2026-1048`, BDT `155311.00`, and four line items. The successful model attempt took 153,212 ms (153,240 ms for the extraction run). Earlier failed runs remain recorded; no extracted values were manufactured or copied from the screenshot. Financial review remains separate from extraction success. Refresh the document details page to see the result.
