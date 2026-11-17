'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useUser } from '../../../components/shell';
import { PageTitle, Notice, Icon, Badge, FileTypeBadge, Loading } from '../../../components/ui';
import { fileSize, useResource } from '../../../lib/client';
import type { UploadAccepted } from '@doc/contracts';
import type { ProgressData } from '../../../lib/types';
import { validateUploadFiles } from '../../../lib/upload';

const SUPPORTED_FORMATS = ['PDF', 'JPG', 'PNG', 'TIFF', 'XLSX', 'XLS', 'CSV'] as const;

function BatchDocument({ id, name }: {
  id: string;
  name: string;
}) {
  const state = useResource<ProgressData>('documents/' + id + '/status?limit=5', 2000);
  return (
    <div className="batch-document">
      <div className="batch-doc-info">
        <FileTypeBadge filename={name} />
        <Link className="text-link" href={'/documents/' + id}>{name}</Link>
      </div>
      <div className="batch-doc-status">
        {state.data ? <Badge value={state.data.status} /> : state.error ? <span className="error-text">{state.error}</span> : <Loading text="Checking status…" />}
        <Link className="button secondary small" href={'/documents/' + id}>
          Inspect <Icon name="arrow" size={14} />
        </Link>
      </div>
    </div>
  );
}

export default function Upload() {
  const user = useUser();
  const input = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const key = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [accepted, setAccepted] = useState<UploadAccepted | null>(null);
  const [drag, setDrag] = useState(false);
  const writable = user.role !== 'reader';

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  function choose(incoming: FileList | File[]) {
    const selected = [...files, ...Array.from(incoming)];
    const problems = validateUploadFiles(selected, user.upload_limits);
    setErrors(problems);
    setFiles(selected);
    key.current = crypto.randomUUID();
    setAccepted(null);
  }

  function send() {
    if (!files.length || busy) return;
    const validation = validateUploadFiles(files, user.upload_limits);
    if (validation.length) {
      setErrors(validation);
      return;
    }
    setErrors([]);
    setBusy(true);
    setProgress(0);
    setAccepted(null);
    const form = new FormData();
    files.forEach(file => form.append('files', file));
    const request = new XMLHttpRequest();
    xhr.current = request;
    request.open('POST', '/api/backend/documents');
    request.setRequestHeader('Idempotency-Key', key.current);
    request.timeout = 180000;
    request.upload.onprogress = event => {
      setProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    request.onload = () => {
      setBusy(false);
      try {
        const body = JSON.parse(request.responseText);
        if (request.status !== 202) throw new Error(body.error?.message ?? 'Upload was not accepted.');
        setAccepted(body as UploadAccepted);
        setFiles([]);
        key.current = crypto.randomUUID();
        setProgress(null);
      } catch (error) {
        setErrors([error instanceof Error ? error.message : 'Upload failed.']);
      }
    };
    request.onerror = request.ontimeout = () => {
      setBusy(false);
      setErrors(['Upload connection interrupted. Retry to check the same batch safely.']);
    };
    request.onabort = () => {
      setBusy(false);
      setProgress(null);
      setErrors(['Upload canceled. Use Retry upload to check whether the batch was accepted.']);
    };
    request.send(form);
  }

  return (
    <>
      <PageTitle
        title="Bring your documents together."
        description="Upload PDFs, images, and spreadsheets. We’ll keep the originals and preserve their source evidence."
      />

      {!writable && (
        <Notice tone="info">Your account has read-only access. A reviewer or administrator can upload documents.</Notice>
      )}

      <section className="panel upload-panel">
        <div
          className={'dropzone ' + (drag ? 'dragging' : '')}
          onDragOver={event => {
            event.preventDefault();
            if (!busy && writable) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={event => {
            event.preventDefault();
            setDrag(false);
            if (!busy && writable) choose(event.dataTransfer.files);
          }}
        >
          <span className="upload-symbol">
            <Icon name="upload" size={30} />
          </span>
          <h2>Drop files here to get started.</h2>
          <p>Or choose multiple files from your computer.</p>
          <button className="button" disabled={busy || !writable} onClick={() => input.current?.click()}>
            Browse files
          </button>
          <input
            ref={input}
            aria-label="Choose documents"
            type="file"
            hidden
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,.xlsx,.xls,.csv"
            onChange={event => {
              if (event.target.files) choose(event.target.files);
              event.target.value = '';
            }}
          />
          <div className="format-chips" aria-label="Supported formats">
            {SUPPORTED_FORMATS.map(fmt => (
              <span key={fmt} className="format-chip">{fmt}</span>
            ))}
          </div>
          <small className="tabular">
            Up to {user.upload_limits.max_files} files · {fileSize(user.upload_limits.max_file_bytes)} per file · {fileSize(user.upload_limits.max_batch_bytes)} per batch
          </small>
        </div>

        {errors.length > 0 && (
          <Notice>
            {errors.map((error, index) => <div key={index}>{error}</div>)}
          </Notice>
        )}

        {files.length > 0 && (
          <>
            <ul className="selected-files">
              {files.map((file, index) => (
                <li key={file.name + index}>
                  <FileTypeBadge filename={file.name} />
                  <div>
                    <strong>{file.name}</strong>
                    <small className="tabular">{fileSize(file.size)}</small>
                  </div>
                  <button
                    className="icon-button compact"
                    aria-label={'Remove ' + file.name}
                    disabled={busy}
                    onClick={() => {
                      const remaining = files.filter((_, i) => i !== index);
                      setFiles(remaining);
                      setErrors(remaining.length ? validateUploadFiles(remaining, user.upload_limits) : []);
                      key.current = crypto.randomUUID();
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>

            {busy && (
              <div className="upload-progress" role="status">
                <div>
                  <span>{progress === 100 ? 'Files transferred. Waiting for server validation…' : 'Uploading files…'}</span>
                  <strong className="tabular">{progress === null ? '' : progress + '%'}</strong>
                </div>
                <progress max={100} {...(progress !== null ? { value: progress } : {})} />
                <small>Processing begins only after the server accepts your batch.</small>
              </div>
            )}

            <div className="upload-actions">
              <div className="upload-summary tabular">
                <span>{files.length} file(s) selected · {fileSize(totalBytes)} total</span>
                {!busy && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setFiles([]);
                      setErrors([]);
                      key.current = crypto.randomUUID();
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>
              {busy ? (
                <button className="button secondary" onClick={() => xhr.current?.abort()}>Cancel transfer</button>
              ) : (
                <button className="button" disabled={!writable} onClick={send}>
                  <Icon name="upload" size={16} />{errors.length ? 'Retry upload' : 'Upload ' + files.length + ' file(s)'}
                </button>
              )}
            </div>
          </>
        )}

        {accepted && (
          <section className="batch-status">
            <Notice tone="success">Batch accepted. Follow live document status below.</Notice>
            <p className="muted small-copy mono">Batch reference: {accepted.batchId}</p>
            {accepted.documents.map(doc => (
              <BatchDocument key={doc.id} id={doc.id} name={doc.originalFilename} />
            ))}
          </section>
        )}
      </section>

      <div className="help-strip">
        <span className="help-strip-icon">
          <Icon name="shield" size={20} />
        </span>
        <div>
          <strong>Your original files stay private.</strong>
          <p>Digital text, scanned pages and worksheets are processed with source references. Uncertain information is flagged for review.</p>
        </div>
      </div>
    </>
  );
}
