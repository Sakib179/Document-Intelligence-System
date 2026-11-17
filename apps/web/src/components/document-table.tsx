'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { DocumentSummary } from '../lib/types';
import { Badge, ConfirmModal, Empty, FileTypeBadge, Icon } from './ui';
import { api, date, label } from '../lib/client';
import { useUser } from './shell';

export function DocumentTable({ documents, onDeleted }: {
  documents: DocumentSummary[];
  onDeleted?: () => void;
}) {
  const user = useUser();
  const writable = user.role !== 'reader';
  const [target, setTarget] = useState<DocumentSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirmDelete() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api('documents/' + target.id, { method: 'DELETE' });
      setTarget(null);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete document.');
    } finally {
      setBusy(false);
    }
  }

  if (!documents.length)
    return <Empty title="No documents found">Upload your first document or adjust your filters.</Empty>;

  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Uploaded</th>
              <th>Processing</th>
              <th>Validation</th>
              <th>Extraction</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {documents.map(doc => (
              <tr key={doc.id} className="table-row-hover">
                <td>
                  <Link className="document-name" href={'/documents/' + doc.id}>
                    <FileTypeBadge filename={doc.originalFilename} />
                    <span>
                      <strong title={doc.originalFilename}>{doc.originalFilename}</strong>
                      <small>{doc.pageCount === null ? 'Pages pending' : doc.pageCount + ' page' + (doc.pageCount === 1 ? '' : 's')}</small>
                    </span>
                  </Link>
                </td>
                <td>
                  <span className="type-pill">{label(doc.documentType)}</span>
                </td>
                <td className="nowrap muted tabular">{date(doc.createdAt)}</td>
                <td>
                  <Badge value={doc.processingStatus} />
                </td>
                <td>
                  <div className="cell-stack">
                    <Badge value={doc.validation_status} />
                    {doc.validation_stale && <span className="stale-tag">Revalidation required</span>}
                  </div>
                </td>
                <td>
                  <div className="cell-stack">
                    <span className={'provider-name ' + (doc.provider ? 'active' : 'muted')}>
                      {doc.provider === 'local_qwen' ? 'Local Qwen' : doc.provider === 'gemini' ? 'Gemini' : 'Not extracted'}
                    </span>
                    {doc.model_id && <small className="cell-note mono" title={doc.model_id}>{doc.model_id}</small>}
                  </div>
                </td>
                <td className="row-action-cell">
                  <div className="row-actions">
                    {writable && onDeleted && (
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label={'Delete ' + doc.originalFilename}
                        title={'Delete ' + doc.originalFilename}
                        onClick={() => {
                          setError('');
                          setTarget(doc);
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                    <Link className="icon-button" aria-label={'Open ' + doc.originalFilename} href={'/documents/' + doc.id}>
                      <Icon name="arrow" size={16} />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={target !== null}
        title="Delete document?"
        description={
          target ? (
            <>
              Remove <strong>{target.originalFilename}</strong> from the workspace. Active processing jobs will be cancelled, stored files removed, and the document will no longer appear in lists, reviews, or search. Audit history is retained.
            </>
          ) : null
        }
        confirmLabel="Delete document"
        busy={busy}
        error={error}
        onCancel={() => {
          setTarget(null);
          setError('');
        }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
