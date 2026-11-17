'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { reconciliationRunSchema } from '@doc/contracts';
import type { DocumentPage } from '../../../lib/types';
import { api, date, label, useResource } from '../../../lib/client';
import { formatComparisonValue, formatFieldPath, formatReconciliationType } from '../../../lib/format';
import { PageTitle, Notice, Loading, Empty, Badge, Icon, Pager, SourceLink } from '../../../components/ui';
import { useUser } from '../../../components/shell';

type Run = ReturnType<typeof reconciliationRunSchema.parse>;

interface Runs {
  items: {
    id: string;
    left_document_id: string;
    right_document_id: string;
    left_filename: string;
    right_filename: string;
    financial_status: string;
    reconciliation_type: string;
    created_at: string;
  }[];
  next_cursor: string | null;
}

function DocumentChoice({ name, title }: {
  name: string;
  title: string;
}) {
  const [q, setQ] = useState('');
  const [documents, setDocuments] = useState<DocumentPage['documents']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const initial = useResource<DocumentPage>('workspace/documents?limit=50&q=' + encodeURIComponent(q));
  const choices = documents.length ? documents : initial.data?.documents ?? [];

  async function more() {
    setBusy(true);
    try {
      const page = await api<DocumentPage>('workspace/documents?limit=50&q=' + encodeURIComponent(q) + '&cursor=' + encodeURIComponent(cursor ?? initial.data?.next_cursor ?? ''));
      setDocuments(items => [...(items.length ? items : initial.data?.documents ?? []), ...page.documents]);
      setCursor(page.next_cursor);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Document list unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="document-choice">
      <label>
        {title}
        <input
          aria-label={'Find ' + title.toLowerCase()}
          placeholder="Find a document by filename…"
          value={q}
          onChange={event => {
            setQ(event.target.value);
            setDocuments([]);
            setCursor(null);
          }}
        />
      </label>
      <label>
        <span className="sr-only">{title} document</span>
        <select name={name} aria-label={title + ' document'} required value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">Choose a document</option>
          {choices.filter(doc => doc.mimeType === 'application/pdf' || /spreadsheet|excel|csv/.test(doc.mimeType)).map(doc => (
            <option key={doc.id} value={doc.id}>
              {doc.originalFilename} · {label(doc.documentType)}
            </option>
          ))}
        </select>
      </label>
      {initial.error && <span className="error-text">{initial.error}</span>}
      {error && <span className="error-text">{error}</span>}
      {(documents.length ? cursor : initial.data?.next_cursor) && (
        <button type="button" className="text-button" disabled={busy} onClick={() => void more()}>
          {busy ? 'Loading…' : 'Load more document choices'}
        </button>
      )}
    </div>
  );
}

export default function Reconciliation() {
  const user = useUser();
  const [run, setRun] = useState<Run | null>(null);
  const [onlyDiscrepancies, setOnlyDiscrepancies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const history = useResource<Runs>('workspace/reconciliations?limit=10' + (cursors.at(-1) ? '&cursor=' + encodeURIComponent(cursors.at(-1)!) : ''));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setRun(null);
    setOnlyDiscrepancies(false);
    try {
      const result = await api<{ run: Run }>('reconciliations', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          left_document_id: form.get('left_document_id'),
          right_document_id: form.get('right_document_id'),
        }),
      });
      setRun(result.run);
      history.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Reconciliation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setBusy(true);
    setError('');
    setOnlyDiscrepancies(false);
    try {
      setRun(await api<Run>('reconciliations/' + id));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Result unavailable.');
    } finally {
      setBusy(false);
    }
  }

  const comparisons = run?.result.comparisons ?? [];
  const matchedCount = comparisons.filter(item => item.match_status === 'matched').length;
  const mismatchCount = comparisons.filter(item => item.match_status === 'mismatch').length;
  const attentionCount = comparisons.filter(item => item.match_status !== 'matched' && item.match_status !== 'mismatch').length;
  const visibleComparisons = onlyDiscrepancies ? comparisons.filter(item => item.match_status !== 'matched') : comparisons;
  const currencyRow = comparisons.find(item => item.field === 'currency');
  const displayCurrency = currencyRow?.expected ?? currencyRow?.actual ?? null;

  return (
    <>
      <PageTitle
        title="Compare with confidence."
        description="Verify invoices across PDFs and spreadsheets, with both sources preserved."
      />

      <section className="panel reconciliation-form">
        <div className="panel-heading">
          <div>
            <h2>Start a comparison</h2>
            <p>Select a PDF and another PDF or an Excel/CSV document.</p>
          </div>
          <Icon name="compare" />
        </div>
        <form onSubmit={submit}>
          <div className="comparison-choices">
            <DocumentChoice name="left_document_id" title="Left source" />
            <span className="comparison-symbol" aria-hidden="true">↔</span>
            <DocumentChoice name="right_document_id" title="Right source" />
          </div>
          <div className="form-actions">
            <span className="muted small-copy">Matches use current invoice snapshots and deterministic rules.</span>
            <button className="button" disabled={busy || user.role === 'reader'}>
              <Icon name="compare" size={16} />{busy ? 'Comparing sources…' : 'Compare documents'}
            </button>
          </div>
          {user.role === 'reader' && <p className="muted">Reviewer access is required to create a comparison.</p>}
        </form>
      </section>

      {error && <Notice>{error}</Notice>}
      {busy && <Loading text="Loading financial comparison…" />}

      {run && (
        <section className="panel comparison-result">
          <div className="panel-heading">
            <div>
              <h2>Comparison result</h2>
              <p className="tabular">
                {date(run.created_at)} · {run.is_current ? 'Current source snapshot' : 'Historical snapshot; sources have changed'}
              </p>
            </div>
            <Badge value={run.financial_status} />
          </div>

          {!run.is_current && (
            <div className="panel-notice-pad">
              <Notice tone="info">This comparison is stale. Create a new comparison using current source values.</Notice>
            </div>
          )}

          <div className="comparison-summary-bar">
            <div className="comparison-stats">
              <span className="stat-chip good tabular">{matchedCount} matched</span>
              <span className="stat-chip danger tabular">{mismatchCount} mismatch{mismatchCount === 1 ? '' : 'es'}</span>
              {attentionCount > 0 && <span className="stat-chip warn tabular">{attentionCount} missing / ambiguous</span>}
            </div>
            <div className="comparison-toolbar">
              <div className="segmented-toggle" role="group" aria-label="Filter comparison rows">
                <button type="button" className={!onlyDiscrepancies ? 'active' : ''} onClick={() => setOnlyDiscrepancies(false)}>
                  All ({comparisons.length})
                </button>
                <button type="button" className={onlyDiscrepancies ? 'active' : ''} onClick={() => setOnlyDiscrepancies(true)}>
                  Discrepancies ({comparisons.length - matchedCount})
                </button>
              </div>
              <div className="comparison-source-links">
                <SourceLink documentId={run.left_document_id}>Open left source</SourceLink>
                <SourceLink documentId={run.right_document_id}>Open right source</SourceLink>
              </div>
            </div>
          </div>

          {visibleComparisons.length ? (
            <div className="table-scroll">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Field / line</th>
                    <th>Left source</th>
                    <th>Right source</th>
                    <th>Comparison</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleComparisons.map((item, index) => {
                    const leftFormatted = formatComparisonValue(item.expected, item.field, displayCurrency);
                    const rightFormatted = formatComparisonValue(item.actual, item.field, displayCurrency);
                    const isNumeric = /(?:^|\.)(?:subtotal|tax|total|unit_price|line_total|quantity|tax_rate)$/.test(item.field);
                    return (
                      <tr key={index} className={item.match_status === 'matched' ? '' : 'discrepancy'}>
                        <td>
                          <strong>{formatFieldPath(item.field)}</strong>
                          {item.code && <small className="cell-note">{label(item.code)}</small>}
                        </td>
                        <td className={isNumeric ? 'tabular' : undefined} title={item.expected ?? undefined}>
                          {leftFormatted ?? <em className="missing-value">Missing</em>}
                        </td>
                        <td className={isNumeric ? 'tabular' : undefined} title={item.actual ?? undefined}>
                          {rightFormatted ?? <em className="missing-value">Missing</em>}
                        </td>
                        <td>
                          <div className="cell-stack">
                            <Badge value={item.match_status} />
                            {item.manual_review_required && <small className="cell-note">Manual review required</small>}
                          </div>
                        </td>
                        <td>
                          <details>
                            <summary>View source</summary>
                            <pre>{JSON.stringify(item.evidence, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={onlyDiscrepancies ? 'No discrepancies found' : 'No field comparisons available'}>
              {onlyDiscrepancies ? 'All compared fields matched.' : 'Review matching and source-coverage issues below.'}
            </Empty>
          )}

          {run.result.issues.length > 0 && (
            <div className="comparison-issues">
              <h3>Issues requiring attention ({run.result.issues.length})</h3>
              <ul className="issue-list">
                {run.result.issues.map((issue, index) => (
                  <li key={index} className={'issue-card sev-' + issue.severity}>
                    <span className={'severity ' + issue.severity} />
                    <div className="issue-body">
                      <div className="issue-header">
                        <strong>{label(issue.code)}</strong>
                        <span className="issue-field-chip">{formatFieldPath(issue.field)}</span>
                      </div>
                      <p className="issue-severity-note">{issue.field} · {issue.severity} severity</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Comparison history</h2>
            <p>Previously recorded PDF and spreadsheet comparisons.</p>
          </div>
          <button className="icon-button" aria-label="Refresh comparison history" onClick={history.reload}>
            <Icon name="refresh" size={17} />
          </button>
        </div>

        {history.loading ? (
          <Loading />
        ) : history.error ? (
          <Notice>{history.error}</Notice>
        ) : !history.data?.items.length ? (
          <Empty title="No comparisons yet">Choose two processed documents to begin.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Sources</th>
                  <th>Type</th>
                  <th>Recorded status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.data.items.map(item => (
                  <tr key={item.id} className="table-row-hover">
                    <td>
                      <strong>{item.left_filename}</strong>
                      <small className="cell-note">Compared with {item.right_filename}</small>
                    </td>
                    <td>
                      <span className="type-pill">{formatReconciliationType(item.reconciliation_type)}</span>
                    </td>
                    <td>
                      <Badge value={item.financial_status} />
                    </td>
                    <td className="muted nowrap tabular">{date(item.created_at)}</td>
                    <td className="row-action-cell">
                      <button className="button secondary small" disabled={busy} onClick={() => void open(item.id)}>
                        Open result
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          canPrevious={cursors.length > 0}
          hasNext={!!history.data?.next_cursor}
          onPrevious={() => setCursors(items => items.slice(0, -1))}
          onNext={() => {
            if (history.data?.next_cursor) setCursors(items => [...items, history.data!.next_cursor!]);
          }}
        />
      </section>
    </>
  );
}
