'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '../lib/types';
import { Icon } from './ui';

export const SIDEBAR_MIN = 72;
export const SIDEBAR_COMPACT_THRESHOLD = 156;
export const SIDEBAR_DEFAULT = 244;
export const SIDEBAR_MAX = 340;

export function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value)));
}

const UserContext = createContext<User | null>(null);
export function useUser() {
  const user = useContext(UserContext); if (!user)
    throw new Error('Workspace context unavailable'); return user;
}
const navigation = [['/', 'Dashboard', 'dashboard'], ['/upload', 'Upload documents', 'upload'], ['/documents', 'Documents', 'document'], ['/reviews', 'Manual review', 'review'], ['/search', 'Search', 'search'], ['/reconciliation', 'Reconciliation', 'compare']] as const;
export function Shell({ user, children }: {
  user: User;
  children: ReactNode;
}) {
  const path = usePathname();
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [resizing, setResizing] = useState(false);
  const lastExpandedWidth = useRef(SIDEBAR_DEFAULT);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const compact = sidebarWidth < SIDEBAR_COMPACT_THRESHOLD;

  const updateWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    if (clamped >= SIDEBAR_COMPACT_THRESHOLD) {
      lastExpandedWidth.current = clamped;
    }
    setSidebarWidth(clamped);
  }, []);

  const toggleCompact = useCallback(() => {
    if (compact) {
      setSidebarWidth(Math.max(SIDEBAR_COMPACT_THRESHOLD + 24, lastExpandedWidth.current));
    } else {
      lastExpandedWidth.current = sidebarWidth;
      setSidebarWidth(SIDEBAR_MIN);
    }
  }, [compact, sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      if (!dragStart.current) return;
      const raw = dragStart.current.width + (event.clientX - dragStart.current.x);
      // Gently snap into clean icon-rail mode when dragged narrow
      if (raw < 118) {
        setSidebarWidth(SIDEBAR_MIN);
      } else {
        updateWidth(raw);
      }
    };
    const onUp = () => {
      setResizing(false);
      dragStart.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [resizing, updateWidth]);

  function onResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragStart.current = { x: event.clientX, width: sidebarWidth };
    setResizing(true);
  }

  function onResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      updateWidth(sidebarWidth - 16);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      updateWidth(compact ? SIDEBAR_COMPACT_THRESHOLD + 24 : sidebarWidth + 16);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      updateWidth(SIDEBAR_MAX);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleCompact();
    }
  }

  const shellStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  return <UserContext value={user}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div className={'app-shell' + (compact ? ' is-sidebar-compact' : '') + (resizing ? ' is-resizing' : '')} style={shellStyle}>
      <aside className="app-sidebar">
        <div className="sidebar-brand-row">
          <Link href="/" className="brand" title="Document Intelligence">
            <span className="brand-mark">Di</span>
            <span className="brand-text">Document<br />Intelligence</span>
          </Link>
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleCompact}
          >
            <Icon name={compact ? 'arrow' : 'arrowLeft'} size={14} />
          </button>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">{navigation.map(([href, title, icon]) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return <Link key={href} href={href} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined} title={compact ? title : undefined}>
            <Icon name={icon} /><span className="nav-text">{title}</span></Link>;
        })}</nav>
        <div className="sidebar-bottom">
          <Link href="/system" className={path.startsWith('/system') ? 'nav-item active' : 'nav-item'} title={compact ? 'Service status' : undefined}>
            <Icon name="clock" /><span className="nav-text">Service status</span></Link>
          <div className="user-card" title={`${user.display_name} (${user.role})`}>
            <span className="avatar">{user.display_name.slice(0, 2).toUpperCase()}</span>
            <div className="user-card-meta">
              <strong>{user.display_name}</strong>
              <small>Workspace operator · {user.role}</small>
            </div>
          </div>
        </div>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title="Drag to resize sidebar (double-click to reset)"
          onPointerDown={onResizeStart}
          onDoubleClick={() => updateWidth(SIDEBAR_DEFAULT)}
          onKeyDown={onResizeKeyDown}
        />
      </aside>
      <div className="app-body">
        <header className="app-topbar">
          <span>Workspace <span className="slash">/</span> {navigation.find(([href]) => href === '/' ? path === '/' : path.startsWith(href))?.[1] ?? 'Service status'}</span>
          <div className="topbar-right">
            <span className="private-label">
              <Icon name="check" size={14} />Local workspace</span>
            <Link href="/upload" className="button small">
              <Icon name="upload" size={15} />Upload files</Link>
          </div>
        </header>
        <main id="main-content" className="app-content">{children}</main>
        <footer className="app-footer">
          <span>Document Intelligence</span>
          <span>Every value has a source.</span>
        </footer>
      </div>
    </div>
  </UserContext>;
}
