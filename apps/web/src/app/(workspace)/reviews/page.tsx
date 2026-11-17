'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, date, label, useResource } from '../../../lib/client';
import { shortId } from '../../../lib/format';
import type { ReviewPage } from '../../../lib/types';
import { PageTitle, Loading, Notice, Empty, Pager, Badge, Icon } from '../../../components/ui';
import { useUser } from '../../../components/shell';

const KINDS = [
  ['all', 'All items'],
  ['invoice', 'Invoices'],
  ['validation_issue', 'Validation issues'],
  ['candidate', 'Uncertain boundaries'],
  ['failed_job', 'Failed jobs'],
] as const;

export default function Reviews() {
  const user = useUser();
  const [cursors, setCursors] = useState<string[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const resource = useResource<ReviewPage>('reviews?limit=20' + (cursors.at(-1) ? '&cursor=' + encodeURIComponent(cursors.at(-1)!) : ''));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function retry(id: string) {
    setBusy(id);
    setError('');
    setMessage('');
    try {
      await api('jobs/' + id + '/retry', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: '{}',
      });
      setMessage('Recovery requested. Follow document processing status for the outcome.');
      resource.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Recovery failed.');
    } finally {
      setBusy('');
    }
  }

  const allItems = resource.data?.items ?? [];
  const filtered = kindFilter === 'all' ? allItems : allItems.filter(item => item.kind === kindFilter);

  return (
    <>
      <PageTitle
        title="A closer look, where it matters."
        description="Review uncertain values, compare original evidence, and keep every correction accountable."
        action={
          <button className="button secondary" onClick={resource.reload}>
            <Icon name="refresh" size={16} />Refresh queue
          </button>
        }
      />

      {error && <Notice>{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {user.role === 'reader' && (
        <Notice tone="info">You can inspect records. Corrections and job recovery require reviewer access.</Notice>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Review queue</h2>
            <p>Invoices, uncertain boundaries, validation issues and failed jobs.</p>
          </div>
          <span className="muted small-copy">Original failures remain in history</span>
        </div>

        {allItems.length > 0 && (
          <div className="filter-pills" role="group" aria-label="Filter review queue by category">
            {KINDS.map(([value, title]) => {
              const count = value === 'all' ? allItems.length : allItems.filter(item => item.kind === value).length;
              return (
                <button
                  type="button"
                  key={value}
                  className={'filter-pill ' + (kindFilter === value ? 'active' : '')}
                  onClick={() => setKindFilter(value)}
                >
                  <span>{title}</span>
                  <span className="pill-count tabular">{count}</span>
                </button>
              );
            })}
          </div>
        )}

        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <Notice>{resource.error}</Notice>
        ) : !filtered.length ? (
          <Empty title="Nothing waiting for review">
            {kindFilter === 'all'
              ? 'New review items will appear when processing identifies uncertainty.'
              : 'No items in this category on the current page.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Review item</th>
                  <th>Category</th>
                  <th>Recorded</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const rawTitle = item.summary.invoice_number ?? item.summary.code ?? item.summary.error_code ?? item.summary.document_type ?? 'Invoice requires review';
                  const displayTitle = typeof rawTitle === 'string' && /^[A-Z0-9_]+$/.test(rawTitle) && rawTitle.includes('_') ? label(rawTitle) : String(rawTitle);
                  return (
                    <tr key={item.kind + item.id} className="table-row-hover">
                      <td>
                        <strong>{displayTitle}</strong>
                        <div className="item-submeta">
                          <span className="mono id-chip" title={item.document_id}>Doc {shortId(item.document_id)}</span>
                          {item.summary.revision !== undefined && (
                            <span className="meta-pill tabular">Rev {String(item.summary.revision)}</span>
                          )}
                          {typeof item.summary.field === 'string' && (
                            <span className="meta-pill">{item.summary.field}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Badge value={item.kind} />
                      </td>
                      <td className="nowrap muted tabular">{date(item.created_at)}</td>
                      <td>
                        <div className="inline-actions">
                          <Link
                            className="button secondary small"
                            href={'/documents/' + item.document_id + (item.kind === 'invoice' ? '?review=' + item.id : item.kind === 'validation_issue' && item.summary.invoice_id ? '?review=' + String(item.summary.invoice_id) : '')}
                          >
                            Open review <Icon name="arrow" size={14} />
                          </Link>
                          {item.kind === 'failed_job' && user.role !== 'reader' && (
                            <button className="text-button" disabled={!!busy} onClick={() => void retry(item.id)}>
                              {busy === item.id ? 'Requesting…' : 'Retry job'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          canPrevious={cursors.length > 0}
          hasNext={!!resource.data?.next_cursor}
          onPrevious={() => setCursors(values => values.slice(0, -1))}
          onNext={() => {
            if (resource.data?.next_cursor) setCursors(values => [...values, resource.data!.next_cursor!]);
          }}
        />
      </section>

      <div className="help-strip">
        <span className="help-strip-icon">
          <Icon name="review" size={20} />
        </span>
        <div>
          <strong>Keep the original. Record the decision.</strong>
          <p>Every saved correction retains extracted values, the reviewer, a timestamp and your reason.</p>
        </div>
      </div>
    </>
  );
}
