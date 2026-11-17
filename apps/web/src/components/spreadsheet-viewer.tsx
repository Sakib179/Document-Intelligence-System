'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SourceData, SourceSummary } from '../lib/types';

type ParsedCell = {
  reference: string;
  row: number;
  column: number;
  rawValue: string;
  displayValue: string;
  formula: string | null;
  isNumeric: boolean;
};

function columnLetter(col: number): string {
  let result = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  }
  return result;
}

function formatCellDisplay(raw: string): { display: string; isNumeric: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { display: '', isNumeric: false };
  const isoDate = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]00:00)?$/.exec(trimmed);
  if (isoDate) return { display: isoDate[1]!, isNumeric: false };
  const isNumeric = /^-?\d+(?:\.\d+)?$/.test(trimmed);
  return { display: trimmed, isNumeric };
}

export function SpreadsheetViewer({
  blocks,
  activeCell,
  sheets,
  activePage,
  onSelectPage,
}: {
  blocks: SourceData['blocks'];
  activeCell?: string | null;
  sheets: SourceSummary[];
  activePage: number;
  onSelectPage: (page: number) => void;
}) {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const activeCellEl = useRef<HTMLTableCellElement | null>(null);

  const parsed = useMemo(() => {
    const list: ParsedCell[] = [];
    const byCoord = new Map<string, ParsedCell>();
    const byRef = new Map<string, ParsedCell>();
    let maxCol = 0;
    const rowSet = new Set<number>();
    for (const block of blocks) {
      if (block.block_type !== 'cell') continue;
      const cell = block.source_reference.cell as {
        reference?: string;
        row?: number;
        column?: number;
        value?: unknown;
        cached_value?: unknown;
        formula?: string | null;
      } | undefined;
      if (!cell || typeof cell.row !== 'number' || typeof cell.column !== 'number') continue;
      const raw = cell.value ?? cell.cached_value;
      const rawValue = raw === null || raw === undefined ? '' : String(raw);
      const { display, isNumeric } = formatCellDisplay(rawValue);
      const reference = cell.reference ?? `${columnLetter(cell.column)}${cell.row}`;
      const entry: ParsedCell = {
        reference,
        row: cell.row,
        column: cell.column,
        rawValue,
        displayValue: display,
        formula: cell.formula ?? null,
        isNumeric,
      };
      list.push(entry);
      byCoord.set(`${cell.row}:${cell.column}`, entry);
      byRef.set(reference.toUpperCase(), entry);
      if (cell.column > maxCol) maxCol = cell.column;
      rowSet.add(cell.row);
    }
    const rows = [...rowSet].sort((a, b) => a - b);
    const cols = Array.from({ length: maxCol }, (_, i) => i + 1);
    return { list, byCoord, byRef, rows, cols };
  }, [blocks]);

  const highlightedRef = activeCell ? activeCell.toUpperCase() : null;
  const inspectedRef = selectedRef ?? highlightedRef ?? parsed.list[0]?.reference ?? null;
  const inspected = inspectedRef ? parsed.byRef.get(inspectedRef.toUpperCase()) ?? null : null;

  useEffect(() => {
    if (highlightedRef) {
      setSelectedRef(highlightedRef);
    }
  }, [highlightedRef]);

  useEffect(() => {
    if (activeCellEl.current) {
      activeCellEl.current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }, [highlightedRef, blocks.length]);

  const worksheetTabs = sheets.filter(item => item.source_kind === 'worksheet' || item.source_kind === 'csv');

  return (
    <div className="sheet-workbench">
      <div className="sheet-formula-bar">
        <span className="sheet-name-box mono">{inspected?.reference ?? '—'}</span>
        <span className="sheet-fx" aria-hidden="true">fx</span>
        <div className="sheet-formula-value" title={inspected?.formula ?? inspected?.rawValue ?? ''}>
          {inspected?.formula ? (
            <>
              <code className="formula-chip">{inspected.formula}</code>
              {inspected.rawValue && <span className="muted small-copy"> = {inspected.rawValue}</span>}
            </>
          ) : (
            <span>{inspected?.rawValue || <em className="missing-value">Empty cell</em>}</span>
          )}
        </div>
        <div className="segmented-toggle sheet-view-toggle" role="group" aria-label="Spreadsheet display mode">
          <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}>Sheet</button>
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>Cells</button>
        </div>
      </div>

      {view === 'grid' ? (
        <div className="table-scroll spreadsheet-preview sheet-grid-scroll">
          <table className="sheet-grid-table">
            <thead>
              <tr>
                <th className="sheet-corner" aria-label="Row number" />
                {parsed.cols.map(col => (
                  <th key={col} className="sheet-col-header mono">{columnLetter(col)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((rowNum, rowIdx) => (
                <tr key={rowNum} className={rowIdx === 0 && rowNum === 1 ? 'sheet-header-row' : undefined}>
                  <th scope="row" className="sheet-row-header tabular">{rowNum}</th>
                  {parsed.cols.map(col => {
                    const cell = parsed.byCoord.get(`${rowNum}:${col}`);
                    const ref = cell?.reference ?? `${columnLetter(col)}${rowNum}`;
                    const isEvidence = highlightedRef === ref.toUpperCase();
                    const isSelected = inspectedRef?.toUpperCase() === ref.toUpperCase();
                    return (
                      <td
                        key={col}
                        ref={isEvidence ? activeCellEl : undefined}
                        title={cell ? `${ref}: ${cell.formula ? `${cell.formula} → ${cell.rawValue}` : cell.rawValue}` : ref}
                        className={[
                          'sheet-cell',
                          cell?.isNumeric ? 'num tabular' : '',
                          cell?.formula ? 'has-formula' : '',
                          isSelected ? 'is-selected' : '',
                          isEvidence ? 'is-evidence' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => setSelectedRef(ref)}
                      >
                        {cell?.displayValue ?? ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-scroll spreadsheet-preview">
          <table className="compact-table">
            <thead>
              <tr>
                <th>Cell</th>
                <th>Original / cached value</th>
                <th>Formula</th>
              </tr>
            </thead>
            <tbody>
              {parsed.list.map(cell => (
                <tr
                  key={cell.reference}
                  className={highlightedRef === cell.reference.toUpperCase() ? 'row-active' : undefined}
                  onClick={() => setSelectedRef(cell.reference)}
                >
                  <td><span className="cell-ref-chip">{cell.reference}</span></td>
                  <td className={cell.isNumeric ? 'tabular' : undefined}>{cell.displayValue}</td>
                  <td>{cell.formula ? <code className="formula-chip">{cell.formula}</code> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {worksheetTabs.length > 1 && (
        <div className="sheet-tab-bar" role="tablist" aria-label="Workbook worksheets">
          {worksheetTabs.map(sheet => (
            <button
              key={sheet.page_number}
              type="button"
              role="tab"
              aria-selected={sheet.page_number === activePage}
              className={'sheet-tab ' + (sheet.page_number === activePage ? 'active' : '')}
              onClick={() => onSelectPage(sheet.page_number)}
            >
              {sheet.worksheet_name ?? `Sheet ${sheet.page_number}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
