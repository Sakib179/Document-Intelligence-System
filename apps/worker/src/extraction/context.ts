import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { InvoiceCandidate } from '@doc/contracts';
import { withTenantTransaction } from '@doc/database';
import type { ExtractionContext, EvidenceSource } from './types.js';
import { ProviderFailure } from './types.js';
import { columnRole } from '../understanding/signals.js';

type CellRow = { id: string; extracted_text: string | null; source_reference: { cell?: {
  reference: string; row: number; column: number; value: string | boolean | null; cached_value: string | boolean | null; formula: string | null } } };

export async function buildExtractionContext(pool: pg.Pool, tenantId: string, candidate: InvoiceCandidate, version: number, maximumChars: number): Promise<ExtractionContext> {
  const sources: EvidenceSource[] = [], warnings = new Set<string>(candidate.review_reasons);
  let characters = 0;
  const add = (source: EvidenceSource) => {
    if (!source.text || sources.some((entry) => entry.id === source.id)) return;
    const length = source.text.length + source.context.length;
    if (source.text.length > 1000 || characters + length > maximumChars || sources.length >= 800) { warnings.add('SOURCE_CONTEXT_TRUNCATED'); return; }
    characters += length; sources.push(source);
  };
  for (const location of candidate.source_locations) {
    if (maximumChars - characters < 128 || sources.length >= 800) { warnings.add('SOURCE_CONTEXT_TRUNCATED'); break; }
    await withTenantTransaction(pool, { tenantId }, async (client) => {
      const page = (await client.query<{ id: string; extracted_text: string | null; worksheet_name: string | null; source_kind: string }>(
        'SELECT id,extracted_text,worksheet_name,source_kind FROM public.document_pages WHERE document_id=$1 AND source_version=$2 AND page_number=$3',
        [candidate.document_id, version, location.page_number],
      )).rows[0];
      if (!page) throw new ProviderFailure('SOURCE_VERSION_NOT_FOUND', false, false);
      if (['pdf_page', 'image_frame'].includes(page.source_kind)) {
        const lines = (page.extracted_text ?? '').split('\n');
        let table = '';
        for (const [index, text] of lines.entries()) {
          if (!text.trim()) continue;
          const looksLikeHeader = /description|item/iu.test(text) && /qty|quantity|unit\s*price/iu.test(text);
          if (looksLikeHeader) table = text.slice(0, 240);
          const relevant = /invoice|date|supplier|vendor|seller|customer|bill\s*to|buyer|sub\s*total|tax|vat|gst|total|amount\s*due|currency|USD|BDT|EUR|GBP|চালান|মোট|ভ্যাট/iu.test(text);
          const priorRelevant = /invoice|date|supplier|customer|bill\s*to|subtotal|tax|total|currency/iu.test(lines[index - 1] ?? '');
          if (relevant || priorRelevant || index < 4 || table) {
            const financialLabel = /\b(?:sub\s*total|tax|vat|total|amount\s+due)\b|মোট|ভ্যাট/iu.test(text)
              || /^(?:sub\s*total|tax|vat|grand\s+total|total|amount\s+due)\s*[:：]?$/iu.test((lines[index - 1] ?? '').trim());
            add({ id: `p:${page.id}:${index + 1}`, page: location.page_number, worksheet: null, cell: null, text,
              context: financialLabel || relevant && !table ? (lines[index - 1] ?? '').slice(0, 240)
                : [table ? 'table_header: ' + table : '', 'preceding_line: ' + (lines[index - 1] ?? '').slice(0, 240)].filter(Boolean).join('\n'),
              role: financialLabel ? 'document_field' : table && !looksLikeHeader ? 'line_item' : 'untyped' });
          }
        }
      } else {
        const start = location.row_start ?? 1, end = location.row_end ?? start;
        const rows = Array.from({ length: Math.min(500, end - start + 1) }, (_, offset) => String(start + offset));
        if (end - start + 1 > 500) warnings.add('SOURCE_CONTEXT_TRUNCATED');
        const headerRows = location.table_header_row ? [String(location.table_header_row)] : Array.from({ length: Math.min(32, start) }, (_, index) => String(index + 1));
        const headerCells = (await client.query<CellRow>(
          "SELECT id,extracted_text,source_reference FROM public.document_blocks WHERE document_id=$1 AND page_id=$2 AND block_type='cell' AND source_reference#>>'{cell,row}'=ANY($3::text[]) ORDER BY block_number LIMIT 1000",
          [candidate.document_id, page.id, headerRows],
        )).rows;
        const byHeaderRow = new Map<number, CellRow[]>();
        for (const entry of headerCells) {
          const cell = entry.source_reference.cell;
          if (cell) byHeaderRow.set(cell.row, [...(byHeaderRow.get(cell.row) ?? []), entry]);
        }
        let headers: CellRow[] = [];
        for (const row of byHeaderRow.values()) if (row.filter((entry) => columnRole(entry.extracted_text ?? '')).length >= 2) headers = row;
        const lineTable = headers.some((entry) => columnRole(entry.extracted_text ?? '') === 'description') && headers.some((entry) => ['quantity', 'unit_price'].includes(columnRole(entry.extracted_text ?? '') ?? ''));
        const headerRowNumber = headers[0]?.source_reference.cell?.row ?? 0;
        const cells = (await client.query<CellRow>(
          "SELECT id,extracted_text,source_reference FROM public.document_blocks WHERE document_id=$1 AND page_id=$2 AND block_type='cell' AND source_reference#>>'{cell,row}'=ANY($3::text[]) ORDER BY block_number LIMIT 1001",
          [candidate.document_id, page.id, rows],
        )).rows;
        if (cells.length > 1000) warnings.add('SOURCE_CONTEXT_TRUNCATED');
        for (const entry of cells.slice(0, 1000)) {
          const cell = entry.source_reference.cell;
          if (!cell) continue;
          if (headerRowNumber > 0 && end > start && cell.row === headerRowNumber) continue;
          const cached = cell.value === null && cell.formula !== null;
          const value = cached ? cell.cached_value : cell.value;
          if (cached) warnings.add(value === null ? 'FORMULA_CACHE_MISSING' : 'CACHED_FORMULA_VALUE');
          if (value === null) continue; // Never expose an unevaluated formula for the LLM to calculate.
          const rowLabel = cells.find((other) => other.source_reference.cell?.row === cell.row && other.source_reference.cell?.column === 1)?.extracted_text ?? '';
          const label = headers.find((other) => other.source_reference.cell?.column === cell.column)?.extracted_text ?? '';
          const ownFinancialLabel = /^(?:subtotal|sub total|tax|tax amount|vat|vat amount|grand total|total|total amount|total due|amount due)$/iu.test(rowLabel.replaceAll('_', ' ').trim());
          add({ id: `b:${entry.id}`, page: location.page_number, worksheet: page.worksheet_name, cell: cell.reference, text: String(value),
            context: `column_header: ${label.slice(0, 160)}\nrow_number: ${cell.row}\nrow_label: ${rowLabel.slice(0, 160)}${cached ? '\ncached_formula_value: true' : ''}`,
            role: ownFinancialLabel ? 'document_field' : lineTable && cell.row > headerRowNumber ? 'line_item' : 'table_cell' });
        }
      }
    });
  }
  if (!sources.length) throw new ProviderFailure('NO_USABLE_SOURCE_EVIDENCE', false, false);
  return { candidate_id: candidate.candidate_id, sources, warnings: [...warnings], digest: createHash('sha256').update(JSON.stringify(sources)).digest('hex') };
}
