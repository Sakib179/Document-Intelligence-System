'use client';

import { useCallback, useEffect, useState } from 'react';
import { systemHealthResponseSchema } from '@doc/contracts';
import type { ServiceName, SystemHealthResponse } from '@doc/contracts';

const services: { service: ServiceName; name: string; detail: string; symbol: string }[] = [
  { service: 'api', name: 'Application API', detail: 'Database, cache, and private storage', symbol: '↔' },
  { service: 'worker', name: 'Queue worker', detail: 'Background job consumer', symbol: '≋' },
  { service: 'document-processor', name: 'Document processor', detail: 'Existing Python runtime', symbol: '⌘' },
  { service: 'web', name: 'Web workspace', detail: 'Your application interface', symbol: '▦' },
];

export function SystemStatus() {
  const [snapshot, setSnapshot] = useState<SystemHealthResponse | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/system-health', { cache: 'no-store', signal: signal ?? AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Status unavailable');
      const result = systemHealthResponseSchema.parse(await response.json());
      if (!signal?.aborted) { setSnapshot(result); setError(false); }
    } catch {
      if (!signal?.aborted) { setError(true); setSnapshot(null); }
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { void refresh(controller.signal); }, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);

  const healthy = snapshot?.services.filter((service) => service.status === 'ok').length ?? 0;
  return (
    <section className="system-section" aria-labelledby="system-title">
      <div className="section-heading"><div><h2 id="system-title">System status</h2><p aria-live="polite">{error ? 'Status could not be retrieved. Try refreshing.' : snapshot ? healthy + ' of 4 services ready' : 'Checking your local services…'}</p></div><button className="refresh" onClick={() => { void refresh(); }} disabled={refreshing}><span aria-hidden="true">↻</span> {refreshing ? 'Checking…' : 'Refresh status'}</button></div>
      <div className="service-grid">{services.map((item) => {
        const health = snapshot?.services.find((entry) => entry.service === item.service);
        const state = health?.status === 'ok' ? 'ready' : health || error ? 'unavailable' : 'checking';
        return <article className="service-card" key={item.service}><div className="card-top"><span className="service-symbol" aria-hidden="true">{item.symbol}</span><span className={'status ' + state}><span className="small-dot" />{state === 'ready' ? 'Ready' : state === 'checking' ? 'Checking' : 'Unavailable'}</span></div><h3>{item.name}</h3><p>{item.detail}</p>{health?.checks && <div className="dependency-checks">{Object.entries(health.checks).map(([name, check]) => <span key={name} className={check.status === 'ok' ? 'check-ok' : 'check-error'}>{check.status === 'ok' ? '✓ ' : '× '}{name === 'objectStorage' ? 'storage' : name}</span>)}</div>}</article>;
      })}</div>
      <div className="status-footnote"><span className="lock" aria-hidden="true">◇</span> Private storage · Local services<span>{snapshot ? 'Checked ' + new Date(snapshot.checkedAt).toLocaleTimeString() : 'Live service checks'}</span></div>
    </section>
  );
}
