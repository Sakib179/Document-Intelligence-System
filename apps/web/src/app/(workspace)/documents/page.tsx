'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useResource } from '../../../lib/client';
import type { DocumentPage } from '../../../lib/types';
import { PageTitle, Notice, Loading, Pager, Icon } from '../../../components/ui';
import { DocumentTable } from '../../../components/document-table';

function DocumentsContent() {
  const searchParams = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [type, setType] = useState(searchParams.get('type') ?? '');
  const [provider, setProvider] = useState(searchParams.get('provider') ?? '');
  const [cursors, setCursors] = useState<string[]>([]);

  const params = new URLSearchParams({
    limit: '20',
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(provider ? { provider } : {}),
    ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}),
  });
  const resource = useResource<DocumentPage>('workspace/documents?' + params);
  const activeFilterCount = [q, status, type, provider].filter(Boolean).length;

  function change(action: () => void) {
    setCursors([]);
    action();
  }

  function resetFilters() {
    setCursors([]);
    setQ('');
    setStatus('');
    setType('');
    setProvider('');
  }

  return (
    <>
      <PageTitle
        title="Your document library."
        description="Original files, current processing status, and validated information in one place."
        action={
          <Link href="/upload" className="button">
            <Icon name="upload" size={16} />Upload files
          </Link>
        }
      />
      <section className="panel">
        <div className="filter-bar">
          <label className="search-field">
            <Icon name="search" size={17} />
            <span className="sr-only">Find a filename</span>
            <input
              placeholder="Find a filename…"
              value={q}
              onChange={event => change(() => setQ(event.target.value))}
            />
          </label>
          <label>
            <span className="sr-only">Processing status</span>
            <select value={status} onChange={event => change(() => setStatus(event.target.value))}>
              <option value="">All statuses</option>
              {['queued', 'processing', 'processed', 'needs_review', 'partially_processed', 'failed', 'rejected'].map(value => (
                <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Document type</span>
            <select value={type} onChange={event => change(() => setType(event.target.value))}>
              <option value="">All document types</option>
              {['invoice', 'invoice_bundle', 'receipt', 'spreadsheet', 'other', 'unknown'].map(value => (
                <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Extraction provider</span>
            <select value={provider} onChange={event => change(() => setProvider(event.target.value))}>
              <option value="">All providers</option>
              <option value="local_qwen">Local Qwen</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          {activeFilterCount > 0 && (
            <button type="button" className="button secondary small" onClick={resetFilters}>
              Clear ({activeFilterCount})
            </button>
          )}
          <button className="icon-button" aria-label="Refresh documents" onClick={resource.reload}>
            <Icon name="refresh" size={18} />
          </button>
        </div>

        {resource.error ? (
          <Notice>{resource.error}</Notice>
        ) : resource.loading ? (
          <Loading />
        ) : (
          <DocumentTable documents={resource.data?.documents ?? []} onDeleted={resource.reload} />
        )}

        <Pager
          canPrevious={cursors.length > 0}
          hasNext={!!resource.data?.next_cursor}
          loading={resource.loading}
          onPrevious={() => setCursors(values => values.slice(0, -1))}
          onNext={() => {
            if (resource.data?.next_cursor) setCursors(values => [...values, resource.data!.next_cursor!]);
          }}
        />
      </section>
    </>
  );
}

export default function Documents() {
  return (
    <Suspense fallback={<Loading text="Loading document library…" />}>
      <DocumentsContent />
    </Suspense>
  );
}
