'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { label } from '../lib/client';
import { fileBadge } from '../lib/format';
import type { ReactNode } from 'react';

export function Icon({ name, size = 20 }: {
  name: string;
  size?: number;
}) {
  const shapes: Record<string, ReactNode> = {
    dashboard: <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>,
    document: <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </>,
    upload: <>
      <path d="M12 15V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>,
    review: <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>,
    search: <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </>,
    compare: <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
      <path d="M10 12h4" />
    </>,
    arrow: <path d="m9 5 7 7-7 7" />,
    arrowLeft: <path d="m15 19-7-7 7-7" />,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    clock: <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
    alert: <>
      <path d="m10.3 3.9-8 14a1.8 1.8 0 0 0 1.6 2.7h16.2a1.8 1.8 0 0 0 1.6-2.7l-8-14a1.8 1.8 0 0 0-3.4 0z" />
      <path d="M12 9v4m0 4h.01" />
    </>,
    refresh: <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15" />
    </>,
    logout: <>
      <path d="M9 3H4v18h5M9 12h12m-4-4 4 4-4 4" />
    </>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    download: <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>,
    zoomIn: <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8M11 8v6M8 11h6" />
    </>,
    zoomOut: <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8M8 11h6" />
    </>,
    sliders: <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </>,
    sparkles: <>
      <path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z" />
    </>,
    shield: <>
      <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z" />
      <path d="m9 12 2 2 4-4" />
    </>,
    trash: <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes[name] ?? shapes.document}
    </svg>
  );
}

export function FileTypeBadge({ filename }: { filename: string }) {
  const { ext, tone } = fileBadge(filename);
  return <span className={'file-type-chip ' + tone} aria-hidden="true">{ext}</span>;
}

export function Badge({ value }: {
  value: string | null | undefined;
}) {
  const text = value ?? 'Not available';
  const tone = /^(processed|succeeded|valid|matched|approved|clean|passed)$/i.test(text)
    ? 'good'
    : /failed|rejected|mismatch|high/i.test(text)
      ? 'danger'
      : /review|warning|partially|stale|ambiguous|medium/i.test(text)
        ? 'warn'
        : /running|processing|queued|pending|retry|hybrid|semantic/i.test(text)
          ? 'info'
          : 'neutral';
  return (
    <span className={'badge ' + tone}>
      <span className="badge-dot" />
      {label(text)}
    </span>
  );
}

export function PageTitle({ eyebrow = 'YOUR WORKSPACE', title, description, action }: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Notice({ children, tone = 'error' }: {
  children: ReactNode;
  tone?: 'error' | 'success' | 'info';
}) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={'notice ' + tone}>
      {children}
    </div>
  );
}

export function Empty({ title, children }: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon name="document" size={26} />
      </div>
      <h3>{title}</h3>
      {children !== undefined && children !== null && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Loading({ text = 'Loading workspace data…' }: {
  text?: string;
}) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}

export function Pager({ hasNext, onNext, onPrevious, canPrevious, loading }: {
  hasNext: boolean;
  onNext: () => void;
  onPrevious: () => void;
  canPrevious: boolean;
  loading?: boolean;
}) {
  return (
    <div className="pager">
      <span>Showing live workspace records</span>
      <div>
        <button className="button secondary small" disabled={!canPrevious || loading} onClick={onPrevious}>
          <Icon name="arrowLeft" size={14} />Previous
        </button>
        <button className="button secondary small" disabled={!hasNext || loading} onClick={onNext}>
          Next page <Icon name="arrow" size={14} />
        </button>
      </div>
    </div>
  );
}

export function SourceLink({ documentId, children }: {
  documentId: string;
  children: ReactNode;
}) {
  return <Link className="text-link" href={'/documents/' + documentId}>{children}</Link>;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Delete document',
  busy = false,
  error = '',
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <div className="modal-header">
          <span className="modal-icon danger">
            <Icon name="trash" size={20} />
          </span>
          <div>
            <h2 id="confirm-modal-title">{title}</h2>
            <p className="modal-description">{description}</p>
          </div>
        </div>
        {error && <Notice>{error}</Notice>}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button danger" disabled={busy} onClick={onConfirm}>
            <Icon name="trash" size={15} />{busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
