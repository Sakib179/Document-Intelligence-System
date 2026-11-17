import { createHash } from 'node:crypto';
import { invoiceCandidateSchema } from '@doc/contracts';
import type { CandidateEvidence, CandidateSource, InvoiceCandidate, ProcessingRecord, UnderstoodType } from '@doc/contracts';
import { columnRole, identifier, normalized, pageSignals } from './signals.js';
import type { ColumnRole, PageSignals } from './signals.js';

type Cell = Extract<ProcessingRecord, { record_type: 'worksheet_rows' }>['cells'][number];
type PageRecord = Extract<ProcessingRecord, { record_type: 'page' }>;
type Draft = InvoiceCandidate & { identity: string | null; supplier: string | null; lastCounter: PageSignals['counter']; excerpt: string; overflow: boolean; isHeaderLedger: boolean; isLineItemSheet: boolean };
type Origin = { artifact: string; line: number };
type Sheet = { page: PageRecord; origin: Origin; current: Draft | null; columns: Map<ColumnRole, number> | null;
  header: { row: number; endColumn: number; quote: string; source: CandidateSource } | null; contextId: string | null; supplier: string | null;
  lineItems: boolean; row: number | null; rowOrigin: Origin | null; rowEndOrigin: Origin | null; cells: Cell[]; lastColumn: number; rowsSeen: number;
  signalCharacters: number; rowLimited: boolean; tableHeaderRow: number | null };
export type UnderstandingResult = {
  candidates: InvoiceCandidate[]; documentType: UnderstoodType; confidence: number; requiresReview: boolean;
  warnings: string[]; adviceInputs: Map<string, { current_excerpt: string; previous_excerpt: string | null }>;
};

function stableId(document: string, run: string, ordinal: number) {
  // RFC 4122 v5 UUID, using the URL namespace and a versioned, scoped name.
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(`document-understanding:${document}:${run}:segmentation-v1:${ordinal}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const columnName = (column: number): string => { let result = ''; for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };
const cellText = (cell: Cell) => cell.value === null ? '' : String(cell.value);
function reason(draft: Draft, value: string) { if (!draft.review_reasons.includes(value)) draft.review_reasons.push(value); draft.requires_manual_review = true; }

/** A single pass over verified canonical records, with one bounded worksheet row in memory. */
export class UnderstandingEngine {
  private readonly drafts: Draft[] = [];
  private readonly pageNumbers = new Set<number>();
  private previous: { signals: PageSignals; draft: Draft; page: number } | null = null;
  private sheet: Sheet | null = null;
  private overflow: Draft | null = null;
  private ended = false;
  constructor(private readonly documentId: string, private readonly runId: string, private readonly candidateLimit = 10_000) {}

  private source(page: PageRecord, origin: Origin, row: number | null = null, endColumn = 1): CandidateSource {
    return { page_number: page.page_number, source_kind: page.source_kind, worksheet_name: page.worksheet_name,
      row_start: row, row_end: row, cell_range: row === null ? null : `A${row}:${columnName(endColumn)}${row}`,
      artifact: origin.artifact, artifact_line: origin.line, end_artifact: origin.artifact, end_artifact_line: origin.line, signal_truncated: false, table_header_row: null };
  }

  private appendSource(draft: Draft, source: CandidateSource) {
    if (source.signal_truncated) reason(draft, 'SIGNAL_TEXT_LIMIT');
    if (!draft.source_pages.includes(source.page_number)) draft.source_pages.push(source.page_number);
    if (source.worksheet_name && !draft.source_worksheets.includes(source.worksheet_name)) draft.source_worksheets.push(source.worksheet_name);
    const last = draft.source_locations.at(-1);
    if (last && last.page_number === source.page_number && last.worksheet_name === source.worksheet_name && last.row_start !== null && source.row_start !== null) {
      last.row_end = Math.max(last.row_end!, source.row_end!);
      const end = source.cell_range?.split(':')[1]?.replace(/\d+$/, '') ?? 'A';
      const prior = last.cell_range?.split(':')[1]?.replace(/\d+$/, '') ?? 'A';
      const widest = end.length > prior.length || (end.length === prior.length && end > prior) ? end : prior;
      last.cell_range = `A${last.row_start}:${widest}${last.row_end}`;
      last.end_artifact = source.end_artifact; last.end_artifact_line = source.end_artifact_line;
      last.signal_truncated ||= source.signal_truncated;
      last.table_header_row ??= source.table_header_row;
    } else if (!last || last.page_number !== source.page_number || source.row_start !== null) draft.source_locations.push({ ...source });
  }

  private create(type: UnderstoodType, confidence: number, source: CandidateSource, reasons: string[] = []): Draft {
    if (this.drafts.length >= this.candidateLimit - 1) {
      if (!this.overflow) {
        this.overflow = this.newDraft('unknown', 0, source, ['CANDIDATE_LIMIT_EXCEEDED']);
        this.overflow.overflow = true;
      } else this.appendSource(this.overflow, source);
      return this.overflow;
    }
    return this.newDraft(type, confidence, source, reasons);
  }

  private newDraft(type: UnderstoodType, confidence: number, source: CandidateSource, reasons: string[]): Draft {
    const draft: Draft = { candidate_id: stableId(this.documentId, this.runId, this.drafts.length + 1), document_id: this.documentId,
      document_type: type, source_pages: [], source_worksheets: [], source_locations: [], segmentation_confidence: confidence,
      requires_manual_review: reasons.length > 0 || type === 'unknown', review_reasons: [...reasons], evidence: [], advisor_suggestion: null,
      identity: null, supplier: null, lastCounter: null, excerpt: '', overflow: false, isHeaderLedger: false, isLineItemSheet: false };
    if (type === 'unknown' && !draft.review_reasons.includes('UNKNOWN_DOCUMENT_TYPE')) draft.review_reasons.push('UNKNOWN_DOCUMENT_TYPE');
    this.appendSource(draft, source);
    this.drafts.push(draft);
    return draft;
  }

  private addEvidence(draft: Draft, evidence: CandidateEvidence[]) {
    for (const item of evidence) if (draft.evidence.length < 24) draft.evidence.push(item);
  }

  consume(record: ProcessingRecord, origin: Origin) {
    if (this.ended) throw new Error('Understanding stream is already finalized');
    if (record.document_id !== this.documentId || record.run_id !== this.runId) throw new Error('Understanding source identity mismatch');
    if (record.record_type === 'page') {
      if (this.pageNumbers.has(record.page_number)) throw new Error('Repeated understanding page');
      this.pageNumbers.add(record.page_number);
      this.finishSheet();
      if (record.source_kind === 'worksheet' || record.source_kind === 'csv') {
        this.finishPdf();
        this.sheet = { page: record, origin, current: null, columns: null, header: null, contextId: null, supplier: null,
          lineItems: false, row: null, rowOrigin: null, rowEndOrigin: null, cells: [], lastColumn: 0, rowsSeen: 0, signalCharacters: 0, rowLimited: false, tableHeaderRow: null };
      } else this.pdf(record, origin);
    } else if (record.record_type === 'worksheet_rows') {
      const sheet = this.sheet;
      if (!sheet || sheet.page.page_number !== record.page_number || sheet.page.worksheet_name !== record.worksheet_name) throw new Error('Worksheet source mismatch');
      for (const cell of record.cells) {
        if (sheet.row !== null && cell.row < sheet.row) throw new Error('Unordered worksheet rows');
        if (sheet.row !== cell.row) { this.flushRow(); sheet.row = cell.row; sheet.lastColumn = 0; sheet.rowOrigin = origin; sheet.signalCharacters = 0; sheet.rowLimited = false; }
        sheet.rowEndOrigin = origin;
        if (cell.column <= sheet.lastColumn || cell.column > 10_000) throw new Error('Invalid worksheet cell order');
        sheet.lastColumn = cell.column;
        const allowance = Math.max(0, Math.min(512, 131_072 - sheet.signalCharacters));
        const value = typeof cell.value === 'string' ? cell.value.slice(0, allowance) : cell.value;
        if (typeof cell.value === 'string' && value !== cell.value) sheet.rowLimited = true;
        sheet.signalCharacters += typeof value === 'string' ? value.length : 0;
        sheet.cells.push({ ...cell, value, formula: cell.formula?.slice(0, 128) ?? null, cached_value: null, source_reference: {} });
      }
    } else {
      if (this.sheet?.page.page_number === record.page_number) {
        this.flushRow(); this.flushHeader();
        if (!this.sheet.current) this.sheet.current = this.create('unknown', 0, this.source(this.sheet.page, this.sheet.origin), ['SOURCE_ERROR']);
        reason(this.sheet.current, 'SOURCE_ERROR');
      } else if (this.previous?.page === record.page_number) reason(this.previous.draft, 'SOURCE_ERROR');
      else throw new Error('Error references an absent source page');
    }
  }

  private finishPdf() {
    const prior = this.previous;
    if (prior?.draft.lastCounter?.total && prior.draft.lastCounter.number < prior.draft.lastCounter.total) reason(prior.draft, 'PAGE_SEQUENCE_INCOMPLETE');
    this.previous = null;
  }

  private pdf(page: PageRecord, origin: Origin) {
    const signals = pageSignals(page.text, page.page_number);
    if (!signals.table && page.blocks.some((block) => block.block_type === 'table' && /description|item/iu.test(JSON.stringify(block.table_data)) && /qty|quantity/iu.test(JSON.stringify(block.table_data)))) signals.table = 'description_quantity_amount';
    const prior = this.previous;
    const primaryId = signals.ids.length === 1 ? signals.ids[0] : null;
    const referenceId = !signals.header && signals.ids.length === 0 && signals.references.length === 1 ? signals.references[0] : null;
    const sameId = Boolean(prior?.draft.identity && prior.draft.identity === (primaryId ?? referenceId));
    const differentId = Boolean(prior?.draft.identity && signals.ids.length && !sameId);
    const supplierConflict = Boolean(prior?.draft.supplier && signals.supplier && prior.draft.supplier !== signals.supplier);
    const sameSupplier = Boolean(prior?.draft.supplier && prior.draft.supplier === signals.supplier);
    const sequential = Boolean(prior?.signals.counter && signals.counter && signals.counter.number === prior.signals.counter.number + 1
      && (signals.counter.total === prior.signals.counter.total) && prior.page + 1 === page.page_number);
    const reset = signals.counter?.number === 1 && prior?.signals.counter !== null && prior !== null;
    const completed = Boolean(prior?.signals.counter?.total && prior.signals.counter.number === prior.signals.counter.total);
    const conflict = differentId || supplierConflict || signals.reasons.includes('CONFLICTING_PAGE_IDENTITIES') || page.error_code !== null
      || ['receipt', 'other_business'].includes(signals.kind) || reset || completed;
    const tableContinues = Boolean(signals.table && prior?.signals.table === signals.table && signals.continued);
    const merge = prior?.draft.document_type === 'invoice' && !conflict && (sameId && (sequential || signals.continued || tableContinues)
      || sameSupplier && sequential && (signals.kind === 'invoice' || signals.continued || Boolean(signals.table)));
    let draft: Draft;
    if (merge && prior) {
      draft = prior.draft;
      this.appendSource(draft, this.source(page, origin));
      draft.segmentation_confidence = Math.min(draft.segmentation_confidence, sameId ? 0.96 : 0.8);
      if (!sameId) reason(draft, 'CONTINUATION_IDENTITY_INCOMPLETE');
      if (!sameSupplier) { reason(draft, 'SUPPLIER_IDENTITY_INCOMPLETE'); draft.segmentation_confidence = Math.min(draft.segmentation_confidence, 0.85); }
      if (!draft.supplier) draft.supplier = signals.supplier;
      this.addEvidence(draft, signals.evidence);
    } else {
      const ambiguous = Boolean(prior?.draft.document_type === 'invoice' && !differentId && !supplierConflict && !reset && !completed
        && (sameId || signals.continued || (signals.counter?.number ?? 0) > 1 || prior.signals.counter?.total && prior.signals.counter.number < prior.signals.counter.total));
      if (prior) {
        if (prior.draft.lastCounter?.total && prior.draft.lastCounter.number < prior.draft.lastCounter.total) reason(prior.draft, 'PAGE_SEQUENCE_INCOMPLETE');
        if (ambiguous) reason(prior.draft, 'AMBIGUOUS_BOUNDARY');
      }
      draft = this.create(signals.kind, signals.confidence, this.source(page, origin), [...signals.reasons, ...(ambiguous ? ['AMBIGUOUS_BOUNDARY'] : [])]);
      draft.identity = signals.ids.length === 1 ? signals.ids[0]! : null;
      draft.supplier = signals.supplier;
      draft.excerpt = signals.excerpt;
      this.addEvidence(draft, signals.evidence);
    }
    if (page.error_code) reason(draft, 'SOURCE_ERROR');
    if (page.ocr_confidence !== null && page.ocr_confidence < 0.6 || page.warnings.includes('LOW_OCR_CONFIDENCE')) reason(draft, 'LOW_OCR_CONFIDENCE');
    if (!draft.overflow) draft.lastCounter = signals.counter;
    this.previous = { signals, draft, page: page.page_number };
  }

  private flushHeader() {
    const sheet = this.sheet;
    if (!sheet?.header) return;
    sheet.current = this.create('unknown', 0.4, sheet.header.source, ['EMPTY_OR_UNCERTAIN_TABLE']);
    sheet.header = null;
  }

  private flushRow() {
    const sheet = this.sheet;
    if (!sheet || sheet.row === null || !sheet.cells.length) return;
    const cells = sheet.cells, row = sheet.row;
    sheet.cells = [];
    sheet.rowsSeen++;
    const source = this.source(sheet.page, sheet.rowOrigin ?? sheet.origin, row, cells.at(-1)!.column);
    source.end_artifact = (sheet.rowEndOrigin ?? sheet.origin).artifact;
    source.end_artifact_line = (sheet.rowEndOrigin ?? sheet.origin).line;
    source.signal_truncated = sheet.rowLimited;
    source.table_header_row = sheet.tableHeaderRow;
    const nonempty = cells.filter((cell) => cellText(cell).trim() || cell.formula);
    if (!nonempty.length) {
      if (sheet.contextId && sheet.current?.document_type === 'invoice') this.appendSource(sheet.current, source);
      else { this.flushHeader(); sheet.columns = null; sheet.current = null; sheet.tableHeaderRow = null; }
      return;
    }
    const roles = new Map<ColumnRole, number>();
    for (const cell of nonempty) { const role = columnRole(cellText(cell)); if (role) roles.set(role, cell.column); }
    const ledger = roles.has('invoice_id') && roles.size >= 3 && (roles.has('total') || roles.has('description'));
    const items = roles.has('description') && (roles.has('quantity') || roles.has('unit_price'));
    if (ledger || items) {
      this.flushHeader();
      sheet.columns = roles; sheet.lineItems = items;
      sheet.tableHeaderRow = row; source.table_header_row = row;
      if (items && sheet.contextId && sheet.current?.document_type === 'invoice') this.appendSource(sheet.current, source);
      else { sheet.header = { row, endColumn: cells.at(-1)!.column, quote: nonempty.map(cellText).join(' | ').slice(0, 240), source }; sheet.current = null; }
      return;
    }
    // Explicit label/value layouts take precedence over reading a title as a table column.
    const first = nonempty[0]!, second = nonempty[1];
    const label = columnRole(cellText(first));
    const rowText = nonempty.map(cellText).join('\n');
    const labeled = pageSignals(rowText, sheet.page.page_number, sheet.page.worksheet_name);
    const labeledId = label === 'invoice_id' && second ? identifier(cellText(second)) : labeled.ids[0] ?? null;
    if (labeled.header && ['receipt', 'other_business'].includes(labeled.kind)) {
      this.flushHeader();
      sheet.current = this.create(labeled.kind, labeled.confidence, source, labeled.reasons);
      this.addEvidence(sheet.current, labeled.evidence);
      sheet.current.excerpt = labeled.excerpt;
      sheet.contextId = null; sheet.supplier = null; sheet.columns = null; sheet.lineItems = false; sheet.tableHeaderRow = null;
      return;
    }
    if (labeledId && (label === 'invoice_id' || !sheet.columns || /^invoice\s*(?:no\b\.?|number\b|#|id\b)/iu.test(cellText(first)))) {
      this.flushHeader();
      if (!sheet.current || sheet.contextId !== labeledId || sheet.current.document_type !== 'invoice' || sheet.columns !== null) {
        const repeatedStart = Boolean(sheet.current?.document_type === 'invoice' && sheet.contextId === labeledId && sheet.columns);
        if (repeatedStart && sheet.current) reason(sheet.current, 'AMBIGUOUS_BOUNDARY');
        sheet.current = this.create('invoice', 0.88, source, repeatedStart ? ['AMBIGUOUS_BOUNDARY'] : []);
        sheet.supplier = null;
      } else this.appendSource(sheet.current, source);
      sheet.contextId = labeledId; sheet.columns = null; sheet.lineItems = false; sheet.tableHeaderRow = null;
      sheet.current.identity = labeledId;
      sheet.current.excerpt = rowText.slice(0, 480);
      this.addEvidence(sheet.current, [{ signal: 'invoice_identifier', quote: rowText.slice(0, 240), page_number: source.page_number, worksheet_name: source.worksheet_name, cell_reference: first.reference }]);
      return;
    }
    if (label === 'supplier' && second && !sheet.columns) {
      const supplier = normalized(cellText(second));
      if (sheet.supplier && supplier !== sheet.supplier && sheet.current?.document_type === 'invoice') {
        reason(sheet.current, 'SUPPLIER_CHANGED_WITHOUT_INVOICE_START'); sheet.current = null; sheet.contextId = null;
      }
      sheet.supplier = supplier;
      if (sheet.current?.document_type === 'invoice') { this.appendSource(sheet.current, source); sheet.current.supplier = supplier; return; }
    }
    if (sheet.columns) {
      const value = (role: ColumnRole) => { const cell = cells.find((item) => item.column === sheet.columns!.get(role)); return cell ? cellText(cell) : ''; };
      const rowId = identifier(value('invoice_id'));
      const id = rowId ?? (sheet.lineItems ? sheet.contextId : null);
      const supplier = normalized(value('supplier')) || sheet.supplier;
      const same = sheet.lineItems && id && sheet.current?.identity === id && sheet.current.supplier === supplier;
      if (sheet.lineItems && sheet.contextId && sheet.current?.document_type === 'invoice'
        && (!rowId || rowId === sheet.contextId) && (!sheet.current.supplier || !supplier || sheet.current.supplier === supplier)) {
        this.appendSource(sheet.current, source);
      } else if (same && sheet.current) this.appendSource(sheet.current, source);
      else {
        const tableSource = sheet.header ? { ...sheet.header.source, row_end: row, end_artifact: source.end_artifact, end_artifact_line: source.end_artifact_line,
          signal_truncated: sheet.header.source.signal_truncated || source.signal_truncated,
          cell_range: `A${sheet.header.row}:${columnName(Math.max(sheet.header.endColumn, cells.at(-1)!.column))}${row}` } : source;
        const candidate = this.create(id ? 'invoice' : 'unknown', id ? 0.91 : 0.4, tableSource, id ? [] : ['MISSING_RECORD_IDENTIFIER']);
        candidate.identity = id; candidate.supplier = supplier;
        candidate.isLineItemSheet = sheet.lineItems;
        candidate.isHeaderLedger = !sheet.lineItems && sheet.columns.has('invoice_id') && sheet.columns.has('total');
        candidate.excerpt = (sheet.header?.quote ?? '') + '\n' + nonempty.slice(0, 4).map(cellText).join(' | ').slice(0, 240);
        this.addEvidence(candidate, [{ signal: 'invoice_table_record', quote: nonempty.slice(0, 4).map(cellText).join(' | ').slice(0, 240),
          page_number: source.page_number, worksheet_name: source.worksheet_name, cell_reference: cells.find((cell) => cell.column === sheet.columns!.get('invoice_id'))?.reference ?? first.reference }]);
        sheet.current = candidate;
        if (sheet.lineItems) { sheet.contextId = id; sheet.supplier = supplier; }
      }
      sheet.header = null;
      return;
    }
    if (sheet.contextId && sheet.current?.document_type === 'invoice') this.appendSource(sheet.current, source);
    else if (sheet.current?.document_type === 'unknown') this.appendSource(sheet.current, source);
    else {
      sheet.current = this.create(labeled.kind, labeled.confidence, source, labeled.reasons);
      this.addEvidence(sheet.current, labeled.evidence); sheet.current.excerpt = labeled.excerpt;
    }
  }

  private finishSheet() {
    if (!this.sheet) return;
    this.flushRow(); this.flushHeader();
    if (!this.drafts.some((draft) => draft.source_pages.includes(this.sheet!.page.page_number))) this.create('unknown', 0.1, this.source(this.sheet.page, this.sheet.origin), ['EMPTY_SOURCE']);
    if (this.sheet.page.error_code && this.drafts.at(-1)) reason(this.drafts.at(-1)!, 'SOURCE_ERROR');
    this.sheet = null;
  }

  private linkRelationalLineItems() {
    // Attach dedicated line-item worksheet records onto matching header-register invoices
    // (same invoice identity + compatible supplier across distinct sheets) so multi-sheet
    // workbooks like Invoice_Register + Line_Items extract complete invoices with line items.
    const merged = new Set<string>();
    const headers = this.drafts.filter((draft) => draft.document_type === 'invoice' && draft.isHeaderLedger && !draft.isLineItemSheet && draft.identity);
    for (const lineDraft of this.drafts) {
      if (lineDraft.document_type !== 'invoice' || !lineDraft.isLineItemSheet || !lineDraft.identity || lineDraft.overflow) continue;
      const lineSheet = lineDraft.source_worksheets[0];
      const candidates = headers.filter((header) => header.identity === lineDraft.identity && !header.source_worksheets.includes(lineSheet ?? ''));
      if (!candidates.length) continue;
      // Prefer header candidates with an exact matching supplier when present on both sheets.
      const exactSupplier = lineDraft.supplier ? candidates.filter((header) => header.supplier === lineDraft.supplier) : [];
      const targets = exactSupplier.length
        ? exactSupplier
        : candidates.filter((header) => !header.supplier || !lineDraft.supplier || header.supplier === lineDraft.supplier);
      if (!targets.length) continue;
      for (const target of targets) {
        for (const location of lineDraft.source_locations) this.appendSource(target, location);
        this.addEvidence(target, lineDraft.evidence);
      }
      merged.add(lineDraft.candidate_id);
    }
    if (merged.size) {
      for (let index = this.drafts.length - 1; index >= 0; index--) {
        if (merged.has(this.drafts[index]!.candidate_id)) this.drafts.splice(index, 1);
      }
    }
  }

  finish(expectedPageCount: number): UnderstandingResult {
    if (this.ended) throw new Error('Understanding stream is already finalized');
    this.finishSheet(); this.finishPdf(); this.linkRelationalLineItems(); this.ended = true;
    if (this.pageNumbers.size !== expectedPageCount) throw new Error('Understanding coverage mismatch');
    const candidates = this.drafts.map(({ identity: _id, supplier: _supplier, lastCounter: _counter, excerpt: _excerpt, overflow: _overflow, isHeaderLedger: _h, isLineItemSheet: _l, ...candidate }) => invoiceCandidateSchema.parse(candidate));
    const types = new Set(candidates.map((candidate) => candidate.document_type));
    const documentType = types.size === 1 ? candidates[0]!.document_type : 'unknown';
    const adviceInputs = new Map<string, { current_excerpt: string; previous_excerpt: string | null }>();
    this.drafts.forEach((draft, index) => {
      if (!draft.overflow && draft.requires_manual_review && draft.excerpt && (draft.document_type === 'unknown' || draft.review_reasons.includes('AMBIGUOUS_BOUNDARY'))) {
        adviceInputs.set(draft.candidate_id, { current_excerpt: draft.excerpt, previous_excerpt: this.drafts[index - 1]?.excerpt ?? null });
      }
    });
    return { candidates, documentType, confidence: candidates.length ? Math.min(...candidates.map((candidate) => candidate.segmentation_confidence)) : 0,
      requiresReview: types.size !== 1 || candidates.some((candidate) => candidate.requires_manual_review),
      warnings: [...(this.overflow ? ['CANDIDATE_LIMIT_EXCEEDED'] : []), ...(types.size !== 1 ? ['MIXED_DOCUMENT_TYPES'] : [])], adviceInputs };
  }
}
