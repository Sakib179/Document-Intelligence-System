'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DocumentDto } from '@doc/contracts';
import type { ProgressData, ResultData, SourceData, SourceSummary } from '../lib/types';
import { api, date, label, useResource } from '../lib/client';
import { formatAmount } from '../lib/format';
import { Badge, ConfirmModal, Empty, FileTypeBadge, Icon, Loading, Notice, Pager } from './ui';
import { AuditHistory, InvoiceReview, InvoiceValues, ValidationPanel } from './invoice-review';
import { SpreadsheetViewer } from './spreadsheet-viewer';
import { useUser } from './shell';
import { evidenceLocation } from '../lib/evidence';
import { extractionState } from '../lib/extraction-state';

const ZOOM_LEVELS = [100, 125, 150, 200] as const;

function SourcePage({ id, page, visual, pending, zoom, activeCell, sheets, onSelectPage }: {
  id: string;
  page: number;
  visual: boolean;
  pending: boolean;
  zoom: number | 'fit';
  activeCell?: string | null;
  sheets: SourceSummary[];
  onSelectPage: (page: number) => void;
}) {
  const source = useResource<SourceData>('documents/' + id + '/pages/' + page, pending ? 2000 : 0);
  const [blocks, setBlocks] = useState<SourceData['blocks']>([]);
  const [after, setAfter] = useState<number | null>(null);
  const [imageError, setImageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setImageError(false);
    const initialBlocks = source.data?.blocks ?? [];
    let nextCursor: number | null = source.data?.next_after ?? null;
    setBlocks(initialBlocks);
    setAfter(nextCursor);
    // For spreadsheets, automatically load up to 4 additional cell batches (500 cells total)
    // so multi-column worksheets render complete rows immediately in the 2D sheet grid.
    if (!visual && nextCursor !== null && initialBlocks.some(b => b.block_type === 'cell')) {
      void (async () => {
        const collected = [...initialBlocks];
        let batches = 0;
        while (!cancelled && nextCursor !== null && batches < 4) {
          try {
            const extra: SourceData = await api<SourceData>('documents/' + id + '/pages/' + page + '?after=' + nextCursor);
            if (cancelled) return;
            collected.push(...extra.blocks);
            nextCursor = extra.next_after;
            batches++;
            setBlocks([...collected]);
            setAfter(nextCursor);
          } catch {
            break;
          }
        }
      })();
    }
    return () => { cancelled = true; };
  }, [source.data, visual, id, page]);

  async function more() {
    if (after === null) return;
    setBusy(true);
    try {
      const value = await api<SourceData>('documents/' + id + '/pages/' + page + '?after=' + after);
      setBlocks(values => [...values, ...value.blocks]);
      setAfter(value.next_after);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Source blocks unavailable.');
    } finally {
      setBusy(false);
    }
  }

  const cells = blocks.filter(block => block.block_type === 'cell');
  return (
    <>
      <div className={'source-canvas ' + (!visual ? 'is-spreadsheet ' : '') + (zoom !== 'fit' ? 'is-zoomed' : '')}>
        {visual ? (
          imageError ? (
            <Empty title="Original preview unavailable">
              The original may be missing or the preview service is unavailable. You can retry or download the original.
            </Empty>
          ) : (
            <img
              key={id + page}
              src={'/api/backend/documents/' + id + '/preview?page=' + page}
              alt={'Original source page ' + page}
              style={zoom === 'fit' ? undefined : { width: zoom + '%', maxWidth: 'none', maxHeight: 'none' }}
              onError={() => setImageError(true)}
            />
          )
        ) : source.loading ? (
          <Loading />
        ) : cells.length ? (
          <SpreadsheetViewer
            blocks={blocks}
            activeCell={activeCell ?? null}
            sheets={sheets}
            activePage={page}
            onSelectPage={onSelectPage}
          />
        ) : (
          <Empty title="No worksheet preview available">Source cells appear after document normalization.</Empty>
        )}
      </div>

      {source.error && !pending && <Notice>{source.error}</Notice>}
      {pending && !source.data && (
        <p className="source-metadata muted small-copy">Source text and OCR details appear when processing completes.</p>
      )}

      {source.data && (
        <div className="source-metadata">
          <div className="source-meta-top">
            <strong>{source.data.worksheet_name ?? 'Page ' + page}</strong>
            <div className="source-meta-pills">
              <span className="meta-pill">Extraction: {label(source.data.extraction_method ?? 'not available')}</span>
              <span className="meta-pill tabular">
                OCR confidence: {source.data.ocr_confidence === null ? 'Not applicable' : (Number(source.data.ocr_confidence) * 100).toFixed(1) + '%'}
              </span>
            </div>
          </div>
          <details>
            <summary>Extracted source text and locations</summary>
            <pre className="source-text">{source.data.extracted_text ?? 'No text on this source page.'}</pre>
            {blocks.filter(block => block.bounding_box).map(block => (
              <p key={block.block_number} className="muted small-copy mono">
                Block {block.block_number} · {block.block_type} · bounds [{block.bounding_box!.join(', ')}]
              </p>
            ))}
            {blocks.filter(block => block.table_data !== null).map(block => (
              <details key={block.block_number}>
                <summary>Extracted table · block {block.block_number}</summary>
                <pre>{JSON.stringify(block.table_data, null, 2)}</pre>
              </details>
            ))}
          </details>
          {after !== null && (
            <button className="button secondary small" disabled={busy} onClick={() => void more()}>
              {busy ? 'Loading…' : 'Load more source cells / blocks'}
            </button>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
      )}
    </>
  );
}

const ACTIVE_JOB_STATUSES = new Set(['pending', 'queued', 'running', 'retry_wait']);

function describeActiveStage(jobs: ProgressData['jobs']['items'], docStatus?: string, cloudRequested = false) {
  const activeJobs = jobs.filter(j => ACTIVE_JOB_STATUSES.has(j.status));
  const runningExtract = activeJobs.find(j => j.job_type === 'extract');
  if (cloudRequested || runningExtract) {
    const waitingCircuit = runningExtract?.progress?.stage === 'waiting_for_provider_circuit';
    return {
      active: true,
      badge: waitingCircuit ? 'Provider cooldown' : runningExtract?.status === 'running' ? 'AI model running' : 'Queued for AI extraction',
      title: waitingCircuit ? 'Waiting for AI provider cooldown' : 'AI model is extracting invoice details',
      detail: waitingCircuit
        ? 'A temporary provider error paused requests briefly. Extraction will resume automatically as soon as the cooldown ends.'
        : 'Reading structured fields, line items, and verifying verbatim quotes against the original source.',
    };
  }
  const runningIngest = activeJobs.find(j => j.job_type === 'ingest');
  if (runningIngest || (docStatus && ['uploading', 'uploaded', 'queued', 'processing', 'ingested'].includes(docStatus))) {
    return {
      active: true,
      badge: runningIngest?.status === 'running' ? 'Analyzing document' : 'Queued for processing',
      title: 'Reading & normalizing document',
      detail: 'Extracting text, running OCR on scanned pages, parsing tables/worksheets, and detecting invoice boundaries.',
    };
  }
  const runningWorkflow = activeJobs.find(j => j.job_type === 'workflow');
  if (runningWorkflow) {
    const waiting = runningWorkflow.progress?.stage === 'waiting_for_extraction';
    return {
      active: true,
      badge: waiting ? 'AI model working' : 'Validating data',
      title: waiting ? 'Waiting for AI extraction to finish' : 'Running financial validation & workflow',
      detail: waiting
        ? 'Extraction is in progress in the background; results will appear automatically.'
        : 'Checking arithmetic, currency tolerances, duplicates, and scheduling downstream updates.',
    };
  }
  const runningIndex = activeJobs.find(j => j.job_type === 'index');
  if (runningIndex) {
    return {
      active: true,
      badge: 'Indexing for search',
      title: 'Generating local search embeddings',
      detail: 'Chunking document passages and updating vector search indexes.',
    };
  }
  return { active: false, badge: '', title: '', detail: '' };
}

function PipelineStepper({ jobs }: { jobs: ProgressData['jobs']['items'] }) {
  const stageState = (type: string) => {
    const matches = jobs.filter(j => j.job_type === type);
    if (!matches.length) return 'idle';
    if (matches.some(j => ACTIVE_JOB_STATUSES.has(j.status))) return 'active';
    if (matches.some(j => j.status === 'succeeded')) return 'done';
    if (matches.some(j => j.status === 'failed')) return 'failed';
    return 'idle';
  };
  const steps = [
    { key: 'ingest', label: 'Ingest & OCR', state: stageState('ingest') },
    { key: 'extract', label: 'AI Extraction', state: stageState('extract') },
    { key: 'workflow', label: 'Validation', state: stageState('workflow') },
    { key: 'index', label: 'Search Index', state: stageState('index') },
  ];
  return (
    <ol className="pipeline-stepper" aria-label="Document processing stages">
      {steps.map(step => (
        <li key={step.key} className={'step ' + step.state}>
          <span className="step-dot">
            {step.state === 'done' ? <Icon name="check" size={12} /> : step.state === 'failed' ? <Icon name="close" size={12} /> : step.state === 'active' ? <span className="step-pulse" /> : null}
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function ActiveProcessingCard({
  jobs,
  stage,
  onInspectJobs,
}: {
  jobs: ProgressData['jobs']['items'];
  stage: { badge: string; title: string; detail: string };
  onInspectJobs: () => void;
}) {
  return (
    <div className="ai-working-card" role="status" aria-live="polite">
      <div className="ai-working-hero">
        <div className="ai-orb" aria-hidden="true">
          <span className="ai-orb-ring" />
          <span className="ai-orb-core">
            <Icon name="sparkles" size={20} />
          </span>
        </div>
        <div className="ai-working-copy">
          <span className="ai-live-pill">
            <span className="ai-live-dot" />
            {stage.badge}
          </span>
          <h3>{stage.title}</h3>
          <p>{stage.detail}</p>
        </div>
      </div>

      <div className="ai-shimmer-track" aria-hidden="true">
        <span className="ai-shimmer-bar" />
      </div>

      <PipelineStepper jobs={jobs} />

      <div className="ai-skeleton-preview" aria-hidden="true">
        <div className="ai-skel-grid">
          <div className="ai-skel-box"><span className="skeleton skel-sm" /><span className="skeleton skel-lg" /></div>
          <div className="ai-skel-box"><span className="skeleton skel-sm" /><span className="skeleton skel-lg" /></div>
          <div className="ai-skel-box"><span className="skeleton skel-sm" /><span className="skeleton skel-lg" /></div>
        </div>
        <div className="ai-skel-rows">
          <span className="skeleton skel-row" />
          <span className="skeleton skel-row short" />
        </div>
      </div>

      <div className="ai-working-footer">
        <span className="muted small-copy">Updating automatically as each stage completes</span>
        <button type="button" className="text-button" onClick={onInspectJobs}>
          View stage details <Icon name="arrow" size={14} />
        </button>
      </div>
    </div>
  );
}

function LiveProcessingBanner({
  stage,
  onInspectJobs,
}: {
  stage: { badge: string; title: string; detail: string };
  onInspectJobs: () => void;
}) {
  return (
    <div className="ai-live-banner" role="status" aria-live="polite">
      <div className="ai-banner-row">
        <span className="ai-orb-mini" aria-hidden="true">
          <Icon name="sparkles" size={14} />
        </span>
        <div className="ai-banner-text">
          <strong>{stage.title}</strong>
          <span>{stage.detail}</span>
        </div>
        <button type="button" className="text-button nowrap" onClick={onInspectJobs}>
          Stage details <Icon name="arrow" size={13} />
        </button>
      </div>
      <div className="ai-shimmer-track compact" aria-hidden="true">
        <span className="ai-shimmer-bar" />
      </div>
    </div>
  );
}

function Processing({ resource, writable }: {
  resource: ReturnType<typeof useResource<ProgressData>>;
  writable: boolean;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function retry(id: string) {
    setBusy(id);
    setError('');
    try {
      await api('jobs/' + id + '/retry', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: '{}',
      });
      resource.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Recovery request failed.');
    } finally {
      setBusy('');
    }
  }

  const failedJobs = resource.data?.jobs.items.filter(job => job.status === 'failed') ?? [];

  async function retryAllFailed() {
    setBusy('all');
    setError('');
    try {
      for (const job of failedJobs) {
        await api('jobs/' + job.id + '/retry', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: '{}',
        });
      }
      resource.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Recovery request failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      {error && <Notice>{error}</Notice>}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <Notice>{resource.error}</Notice>
      ) : resource.data?.jobs.items.length ? (
        <>
          <div className="subsection-heading">
            <PipelineStepper jobs={resource.data.jobs.items} />
            {failedJobs.length > 1 && writable && (
              <button className="button secondary small" disabled={!!busy} onClick={() => void retryAllFailed()}>
                <Icon name="refresh" size={14} />{busy === 'all' ? 'Scheduling retries…' : `Retry all failed (${failedJobs.length})`}
              </button>
            )}
          </div>
          <div className="job-list">
            {resource.data.jobs.items.map(job => (
              <div key={job.id} className={'job-card status-' + job.status}>
                <div className="subsection-heading">
                  <div className="heading-with-badge">
                    <strong>{label(job.job_type)}</strong>
                    <span className="muted small-copy tabular">Attempt {job.attempts}/{job.max_attempts}</span>
                  </div>
                  <Badge value={job.status} />
                </div>
                <p className="job-stage">
                  {typeof job.progress.stage === 'string' ? label(job.progress.stage) : 'Attempt ' + job.attempts + ' of ' + job.max_attempts}
                </p>
                {job.last_error_code && <p className="error-text">{label(job.last_error_code)}</p>}
                <div className="job-footer">
                  <small className="muted tabular">{date(job.created_at)}</small>
                  {job.status === 'failed' && writable && (
                    <button className="button secondary small" disabled={!!busy} onClick={() => void retry(job.id)}>
                      <Icon name="refresh" size={14} />{busy === job.id ? 'Requesting recovery…' : 'Retry failed job'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <Empty title="No processing jobs">New uploads create durable processing jobs.</Empty>
      )}
    </>
  );
}

export function DocumentDetail({ id, reviewInvoice }: {
  id: string;
  reviewInvoice?: string;
}) {
  const router = useRouter();
  const user = useUser();
  const detail = useResource<{ document: DocumentDto }>('documents/' + id);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const result = useResource<ResultData>('documents/' + id + '/result?limit=20' + (cursorStack.at(-1) ? '&cursor=' + encodeURIComponent(cursorStack.at(-1)!) : ''));
  const status = useResource<ProgressData>('documents/' + id + '/status?limit=30', 2000);
  const pages = useResource<{ pages: SourceSummary[]; next_cursor: string | null }>('documents/' + id + '/pages?limit=100');
  const [morePages, setMorePages] = useState<SourceSummary[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [invoiceId, setInvoiceId] = useState(reviewInvoice ?? '');
  const [tab, setTab] = useState(reviewInvoice ? 'review' : 'extracted');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState('');
  const [evidence, setEvidence] = useState<unknown>(null);
  const [activeEvidenceKey, setActiveEvidenceKey] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [extractingCloud, setExtractingCloud] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [cloudError, setCloudError] = useState('');

  async function retryFailedExtractions() {
    setRetryingFailed(true);
    setCloudError('');
    setSaved('');
    try {
      const failed = (status.data?.jobs.items ?? []).filter(j => j.status === 'failed');
      const failedExtract = failed.filter(j => j.job_type === 'extract');
      if (failedExtract.length) {
        await api('documents/' + id + '/extractions', {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: '{}',
        });
      } else {
        for (const job of failed) {
          await api('jobs/' + job.id + '/retry', {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: '{}',
          });
        }
      }
      setSaved('Extraction retry scheduled.');
      status.reload();
      result.reload();
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Could not retry failed extraction.');
    } finally {
      setRetryingFailed(false);
    }
  }

  async function extractWithGemini() {
    setExtractingCloud(true);
    setCloudError('');
    setSaved('');
    try {
      const privacy = await api<{ gemini_permitted: boolean }>('documents/' + id + '/privacy', {
        method: 'PATCH',
        body: JSON.stringify({
          data_classification: 'confidential',
          cloud_processing_allowed: true,
          reason: 'Administrator approved document for Gemini cloud extraction from workspace UI',
        }),
      });
      if (!privacy.gemini_permitted) {
        throw new Error('Cloud LLM is disabled on the server. Set CLOUD_LLM_ENABLED=true and restart the API and worker.');
      }
      await api('documents/' + id + '/extractions', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: '{}',
      });
      setSaved('Document approved for cloud AI and Gemini extraction scheduled.');
      status.reload();
      result.reload();
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : 'Could not start Gemini extraction.');
    } finally {
      setExtractingCloud(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    try {
      await api('documents/' + id, { method: 'DELETE' });
      setDirty(false);
      setConfirmDeleteOpen(false);
      router.push('/documents');
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete document.');
      setDeleting(false);
    }
  }

  const fingerprint = status.data?.jobs.items.map(job => job.id + job.status).join(',');
  useEffect(() => {
    if (fingerprint && !dirty) {
      result.reload();
      pages.reload();
    }
  }, [fingerprint, dirty, result.reload, pages.reload]);

  useEffect(() => {
    if (dirty) {
      const listener = (event: BeforeUnloadEvent) => event.preventDefault();
      window.addEventListener('beforeunload', listener);
      return () => window.removeEventListener('beforeunload', listener);
    }
  }, [dirty]);

  useEffect(() => {
    setMorePages(pages.data?.pages ?? []);
    setPageCursor(pages.data?.next_cursor ?? null);
  }, [pages.data]);

  const extraction = extractionState(result.data, status.data);
  const invoice = result.data?.invoices.find(item => item.id === invoiceId) ?? result.data?.invoices[0];
  const doc = detail.data?.document;
  const run = invoice ? result.data?.provenance?.[invoice.id] : null;
  const jobs = status.data?.jobs.items ?? [];
  const activeStage = describeActiveStage(jobs, status.data?.status ?? doc?.processingStatus, extractingCloud);
  const noInvoicesDetected = Boolean(result.data?.understanding?.runId && result.data?.understanding?.invoiceCandidateCount === 0);
  const isVisual = !!doc && (doc.mimeType === 'application/pdf' || doc.mimeType.startsWith('image/'));
  const maxKnownPage = Math.max(page, doc?.pageCount ?? 1, ...morePages.map(item => item.page_number));

  function showEvidence(value: unknown, key?: string) {
    setEvidence(value);
    setActiveEvidenceKey(key ?? null);
    const candidate = evidenceLocation(value);
    if (candidate.page) {
      setPage(candidate.page);
    } else if (candidate.worksheet) {
      const match = morePages.find(item => item.worksheet_name === candidate.worksheet);
      if (match) setPage(match.page_number);
    }
  }

  async function more() {
    if (!pageCursor) return;
    try {
      const value = await api<{ pages: SourceSummary[]; next_cursor: string | null }>('documents/' + id + '/pages?limit=100&cursor=' + encodeURIComponent(pageCursor));
      setMorePages(items => [...items, ...value.pages]);
      setPageCursor(value.next_cursor);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Page list unavailable.');
    }
  }

  const evidenceInfo = evidence !== null ? evidenceLocation(evidence) : null;

  return (
    <>
      <header className="doc-topbar">
        <div className="doc-topbar-left">
          <Link className="icon-button compact" href="/documents" aria-label="Back to documents" title="Back to documents">
            <Icon name="arrowLeft" size={15} />
          </Link>
          {doc && <FileTypeBadge filename={doc.originalFilename} />}
          <div className="doc-topbar-title">
            <h1 title={doc?.originalFilename ?? 'Document details'}>{doc?.originalFilename ?? 'Document details'}</h1>
            <div className="doc-topbar-meta">
              <Badge value={status.data?.status ?? doc?.processingStatus} />
              <span className="type-pill">{doc ? label(doc.documentType) : 'Loading…'}</span>
              <span className="strip-meta tabular">
                {doc?.pageCount ?? '—'} {isVisual ? 'page' : 'sheet'}{(doc?.pageCount ?? 0) === 1 ? '' : 's'}
              </span>
              {doc && <span className="strip-meta tabular hide-sm">· {date(doc.createdAt)}</span>}
            </div>
          </div>
        </div>
        <div className="inline-actions doc-topbar-actions">
          <a className="button secondary small" href={'/api/backend/documents/' + id + '/content?download=1'}>
            <Icon name="download" size={14} />Download
          </a>
          {user.role !== 'reader' && (
            <button
              type="button"
              className="button secondary small danger-outline"
              onClick={() => {
                setDeleteError('');
                setConfirmDeleteOpen(true);
              }}
            >
              <Icon name="trash" size={14} />Delete
            </button>
          )}
        </div>
      </header>

      <ConfirmModal
        open={confirmDeleteOpen}
        title="Delete document?"
        description={
          <>
            Remove <strong>{doc?.originalFilename ?? 'this document'}</strong> from the workspace. Active processing jobs will be cancelled, stored files removed, and the document will no longer appear in lists, reviews, or search. Audit history is retained.
          </>
        }
        confirmLabel="Delete document"
        busy={deleting}
        error={deleteError}
        onCancel={() => {
          setConfirmDeleteOpen(false);
          setDeleteError('');
        }}
        onConfirm={() => void handleDelete()}
      />

      {detail.error && <Notice>{detail.error}</Notice>}
      {cloudError && <Notice>{cloudError}</Notice>}
      {saved && <Notice tone="success">{saved}</Notice>}

      <div className="document-split">
        <section className="panel preview-panel">
          <div className="panel-heading preview-heading">
            <div>
              <h2>Original source</h2>
              <p>
                {doc?.mimeType === 'application/pdf'
                  ? 'PDF page preview'
                  : doc?.mimeType.startsWith('image/')
                    ? 'Original image / frame'
                    : 'Original worksheet cells; formulas are never executed'}
              </p>
            </div>
            <div className="preview-controls">
              {isVisual && (
                <div className="zoom-group" role="group" aria-label="Preview zoom">
                  <button
                    type="button"
                    className={'zoom-btn ' + (zoom === 'fit' ? 'active' : '')}
                    onClick={() => setZoom('fit')}
                  >
                    Fit
                  </button>
                  {ZOOM_LEVELS.map(level => (
                    <button
                      type="button"
                      key={level}
                      className={'zoom-btn ' + (zoom === level ? 'active' : '')}
                      onClick={() => setZoom(level)}
                    >
                      {level}%
                    </button>
                  ))}
                </div>
              )}
              <div className="page-nav">
                <button
                  type="button"
                  className="icon-button compact"
                  aria-label="Previous source page"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  <Icon name="arrowLeft" size={14} />
                </button>
                <label>
                  <span className="sr-only">Source page</span>
                  <select aria-label="Source page" value={page} onChange={event => setPage(Number(event.target.value))}>
                    {!morePages.some(item => item.page_number === page) && <option value={page}>Page {page}</option>}
                    {morePages.map(item => (
                      <option key={item.page_number} value={item.page_number}>
                        {item.worksheet_name ?? 'Page ' + item.page_number}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-button compact"
                  aria-label="Next source page"
                  disabled={page >= maxKnownPage}
                  onClick={() => setPage(p => Math.min(maxKnownPage, p + 1))}
                >
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            </div>
          </div>

          {evidenceInfo && (
            <div className="evidence-panel">
              <div className="subsection-heading">
                <div className="heading-with-badge">
                  <strong>Supporting evidence</strong>
                  {evidenceInfo.page && <span className="meta-pill">Page {evidenceInfo.page}</span>}
                  {evidenceInfo.worksheet && <span className="meta-pill">{evidenceInfo.worksheet}</span>}
                  {evidenceInfo.cell && <span className="cell-ref-chip">{evidenceInfo.cell}</span>}
                </div>
                <button
                  className="icon-button compact"
                  aria-label="Close evidence"
                  onClick={() => {
                    setEvidence(null);
                    setActiveEvidenceKey(null);
                  }}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              <blockquote>{evidenceInfo.text ?? 'Source details'}</blockquote>
              <details>
                <summary>Full source reference</summary>
                <pre>{JSON.stringify(evidence, null, 2)}</pre>
              </details>
            </div>
          )}

          {doc ? (
            <SourcePage
              key={id + page}
              id={id}
              page={page}
              zoom={zoom}
              activeCell={evidenceInfo?.cell ?? null}
              sheets={morePages}
              onSelectPage={setPage}
              pending={['uploading', 'uploaded', 'queued', 'processing', 'ingested'].includes(status.data?.status ?? doc.processingStatus)}
              visual={isVisual}
            />
          ) : (
            <Loading />
          )}

          {pageCursor && (
            <div className="load-more-wrap">
              <button className="text-button" onClick={() => void more()}>Load more page choices</button>
            </div>
          )}
          {pageError && <Notice>{pageError}</Notice>}
        </section>

        <section className="panel extraction-panel">
          <div className="panel-heading">
            <div>
              <h2>Extracted information</h2>
              <p className="provenance-line">
                {run?.provider === 'gemini'
                  ? 'Gemini'
                  : run?.provider === 'local_qwen'
                    ? 'Local Qwen'
                    : !invoice && result.data?.understanding?.invoiceCandidateCount === 0
                      ? 'Invoice extraction skipped · no invoice candidates'
                      : 'No invoice extraction result'}
                {run?.model_id ? ' · ' + run.model_id : ''}
              </p>
              {run?.model_version && <small className="muted mono">Model version: {run.model_version}</small>}
            </div>
            <div className="inline-actions">
              {user.role === 'admin' && doc && !['uploading', 'uploaded', 'queued', 'processing'].includes(status.data?.status ?? doc.processingStatus) && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={dirty || extractingCloud}
                  onClick={() => void extractWithGemini()}
                >
                  <Icon name="sparkles" size={14} />{extractingCloud ? 'Scheduling Gemini…' : 'Extract with Gemini'}
                </button>
              )}
              {invoice && (
                <label className="invoice-picker">
                  <span className="sr-only">Invoice</span>
                  <select aria-label="Invoice" disabled={dirty} value={invoice.id} onChange={event => setInvoiceId(event.target.value)}>
                    {result.data?.invoices.map((item, index) => {
                      const amt = formatAmount(item.total, item.currency);
                      const suffix = amt ? ` · ${amt}${item.currency ? ' ' + item.currency : ''}` : '';
                      return (
                        <option key={item.id} value={item.id}>
                          {(item.invoice_number ?? 'Invoice ' + (index + 1)) + suffix}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Document information">
            {[
              ['extracted', 'Extracted data'],
              ['review', 'Manual review'],
              ['history', 'Audit history'],
              ['processing', 'Processing'],
            ].map(([value, title]) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                disabled={dirty && tab !== value}
                className={tab === value ? 'selected' : ''}
                onClick={() => setTab(value!)}
              >
                {title}
              </button>
            ))}
          </div>

          <div className="document-tab">
            {dirty && <Notice tone="info">Unsaved changes. Save or cancel before switching invoices or tabs.</Notice>}

            {tab === 'processing' ? (
              <>
                {!invoice && result.data && (
                  <Notice tone="info">
                    <strong>{extraction.title}</strong>
                    <p>{extraction.message}</p>
                    <p>Successful ingestion and indexing mean source data is readable and searchable; they do not mean invoice fields were extracted.</p>
                  </Notice>
                )}
                <Processing resource={status} writable={user.role !== 'reader'} />
              </>
            ) : result.loading ? (
              <Loading />
            ) : result.error ? (
              <Notice>{result.error}</Notice>
            ) : !invoice ? (
              activeStage.active && !noInvoicesDetected ? (
                <ActiveProcessingCard
                  jobs={jobs}
                  stage={activeStage}
                  onInspectJobs={() => setTab('processing')}
                />
              ) : (
                <>
                  <Empty title={extraction.title}>
                    <p>{extraction.message}</p>
                    {jobs.some(j => j.status === 'failed') && (
                      <>
                        {Array.from(new Set(jobs.filter(j => j.status === 'failed' && j.last_error_code).map(j => j.last_error_code!))).length > 0 && (
                          <div className="source-meta-pills" style={{ justifyContent: 'center', marginTop: '0.75rem' }}>
                            {Array.from(new Set(jobs.filter(j => j.status === 'failed' && j.last_error_code).map(j => j.last_error_code!))).map(code => (
                              <span key={code} className="meta-pill error-text">{label(code)}</span>
                            ))}
                          </div>
                        )}
                        <div className="inline-actions" style={{ justifyContent: 'center', marginTop: '1rem' }}>
                          {user.role === 'admin' && (
                            <button
                              type="button"
                              className="button primary small"
                              disabled={extractingCloud || retryingFailed}
                              onClick={() => void extractWithGemini()}
                            >
                              <Icon name="sparkles" size={14} />{extractingCloud ? 'Scheduling Gemini…' : 'Extract with Gemini'}
                            </button>
                          )}
                          {user.role !== 'reader' && (
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={retryingFailed || extractingCloud}
                              onClick={() => void retryFailedExtractions()}
                            >
                              <Icon name="refresh" size={14} />{retryingFailed ? 'Retrying…' : 'Retry extraction'}
                            </button>
                          )}
                          <button type="button" className="text-button" onClick={() => setTab('processing')}>
                            View stage details <Icon name="arrow" size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </Empty>
                  {result.data?.understanding && (
                    <div className="source-metadata">
                      <strong>Source extraction summary</strong>
                      <p>
                        Classification: {label(result.data.document_type)} · Pages / worksheets: {result.data.page_count ?? 'Unknown'} · Invoice candidates: {String(result.data.understanding.invoiceCandidateCount ?? 'Unknown')}
                      </p>
                      {result.data.understanding.requiresManualReview === true && (
                        <p>Document classification requires manual review. No invoice values have been invented.</p>
                      )}
                    </div>
                  )}
                </>
              )
            ) : tab === 'review' ? (
              <InvoiceReview
                key={invoice.id + ':' + invoice.revision}
                invoice={invoice}
                onDirty={setDirty}
                onCancel={() => {
                  setSaved('');
                  result.reload();
                }}
                onSaved={() => {
                  setSaved('Correction saved. Follow-up validation and indexing run in the background.');
                  result.reload();
                  status.reload();
                }}
              />
            ) : tab === 'history' ? (
              <AuditHistory key={invoice.id} invoiceId={invoice.id} />
            ) : (
              <>
                {activeStage.active && (
                  <LiveProcessingBanner stage={activeStage} onInspectJobs={() => setTab('processing')} />
                )}
                <InvoiceValues
                  invoice={invoice}
                  activeEvidenceKey={activeEvidenceKey}
                  onEvidence={showEvidence}
                />
                <ValidationPanel
                  invoiceId={invoice.id}
                  onTermsUpdated={result.reload}
                  onOpenReview={() => setTab('review')}
                />
              </>
            )}
          </div>

          <Pager
            canPrevious={cursorStack.length > 0 && !dirty}
            hasNext={!!result.data?.next_cursor && !dirty}
            onPrevious={() => setCursorStack(items => items.slice(0, -1))}
            onNext={() => {
              if (result.data?.next_cursor) setCursorStack(items => [...items, result.data!.next_cursor!]);
            }}
          />
        </section>
      </div>
    </>
  );
}
