'use client';
import Link from 'next/link';
import { useResource, date, label } from '../../lib/client';
import type { DashboardData, DocumentPage } from '../../lib/types';
import { PageTitle, Notice, Loading, Empty, Badge, Icon, SourceLink } from '../../components/ui';
import { DocumentTable } from '../../components/document-table';

const METRICS = [
  { title: 'Total documents', key: 'total', icon: 'document', tone: 'neutral', href: '/documents', note: 'Across this workspace' },
  { title: 'Completed', key: 'completed', icon: 'check', tone: 'good', href: '/documents?status=processed', note: 'Source processing complete' },
  { title: 'Processing', key: 'processing', icon: 'clock', tone: 'info', href: '/documents?status=processing', note: 'Queued or in progress' },
  { title: 'Failed', key: 'failed', icon: 'alert', tone: 'danger', href: '/documents?status=failed', note: 'Failed or rejected documents' },
  { title: 'Invoices to review', key: 'review_required_invoices', icon: 'review', tone: 'amber', href: '/reviews', note: 'Awaiting manual review' },
] as const;

export default function Dashboard() {
  const summary = useResource<DashboardData>('dashboard', 10000);
  const recent = useResource<DocumentPage>('workspace/documents?limit=6', 10000);
  const counts = summary.data?.counts;
  const total = counts?.total ?? 0;
  const pct = (value: number) => total > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / total) * 100)) : 0;

  return (
    <>
      <PageTitle
        title="A clearer view of your documents."
        description="Track processing, review what needs attention, and find the information that matters."
        action={
          <Link className="button" href="/upload">
            <Icon name="upload" size={17} />Upload documents
          </Link>
        }
      />

      {summary.error && (
        <Notice>
          {summary.error}
          <button className="text-button" onClick={summary.reload}>Try again</button>
        </Notice>
      )}

      <div className="metric-grid">
        {METRICS.map(item => (
          <Link href={item.href} className={'metric-card tone-' + item.tone} key={item.key}>
            <div className="metric-top">
              <span className="metric-label">{item.title}</span>
              <span className={'metric-icon ' + item.tone}>
                <Icon name={item.icon} size={18} />
              </span>
            </div>
            <strong className="tabular">
              {counts ? counts[item.key] : <span className="skeleton metric-skeleton" />}
            </strong>
            <small>{item.note}</small>
          </Link>
        ))}
      </div>

      {counts && total > 0 && (
        <section className="health-strip" aria-label="Workspace processing distribution">
          <div className="health-strip-header">
            <span className="health-strip-title">Pipeline completion</span>
            <div className="health-strip-legend">
              <span><i className="dot good" />{counts.completed} completed</span>
              {counts.processing > 0 && <span><i className="dot info" />{counts.processing} in progress</span>}
              {counts.partial > 0 && <span><i className="dot warn" />{counts.partial} partial</span>}
              {counts.failed > 0 && <span><i className="dot danger" />{counts.failed} failed</span>}
            </div>
          </div>
          <div className="health-bar" role="img" aria-label={`${counts.completed} of ${total} documents processed`}>
            {counts.completed > 0 && <span className="seg good" style={{ width: pct(counts.completed) + '%' }} />}
            {counts.processing > 0 && <span className="seg info" style={{ width: pct(counts.processing) + '%' }} />}
            {counts.partial > 0 && <span className="seg warn" style={{ width: pct(counts.partial) + '%' }} />}
            {counts.failed > 0 && <span className="seg danger" style={{ width: pct(counts.failed) + '%' }} />}
          </div>
        </section>
      )}

      {counts && counts.partial > 0 && (
        <Notice tone="info">
          {counts.partial} document(s) have partially processed pages. Open their details to review source warnings.
        </Notice>
      )}

      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent documents</h2>
              <p>Your latest uploads and their current status.</p>
            </div>
            <Link className="text-link" href="/documents">
              View all <Icon name="arrow" size={14} />
            </Link>
          </div>
          {recent.loading ? (
            <Loading />
          ) : recent.error ? (
            <Notice>{recent.error}</Notice>
          ) : (
            <DocumentTable
              documents={recent.data?.documents ?? []}
              onDeleted={() => {
                recent.reload();
                summary.reload();
              }}
            />
          )}
        </section>

        <section className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>Processing activity</h2>
              <p>Latest updates from the workflow.</p>
            </div>
            <Icon name="clock" size={18} />
          </div>
          {summary.loading ? (
            <Loading />
          ) : !summary.data?.activity.length ? (
            <Empty title="No activity yet">Processing updates will appear after your first upload.</Empty>
          ) : (
            <ol className="activity-list">
              {summary.data.activity.map(item => (
                <li key={item.id}>
                  <span className={'activity-dot ' + (item.status === 'failed' ? 'red' : item.status === 'running' ? 'blue' : '')} />
                  <div>
                    <SourceLink documentId={item.document_id}>{item.original_filename}</SourceLink>
                    <span className="activity-meta">
                      <span className="stage-chip">{label(item.job_type)}</span>
                      <Badge value={item.status} />
                    </span>
                    {item.last_error_code && <small className="error-text">{label(item.last_error_code)}</small>}
                    <time className="tabular">{date(item.updated_at)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="help-strip">
        <span className="help-strip-icon">
          <Icon name="shield" size={20} />
        </span>
        <div>
          <strong>Good decisions start with traceable information.</strong>
          <p>Review original values and source evidence before making a correction.</p>
        </div>
        <Link className="text-link" href="/reviews">
          Open review queue <Icon name="arrow" size={14} />
        </Link>
      </div>

      {summary.data && (
        <p className="freshness tabular">
          Updated {date(summary.data.checked_at)} · Refreshes every 10 seconds
        </p>
      )}
    </>
  );
}
