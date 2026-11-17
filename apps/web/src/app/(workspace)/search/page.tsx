'use client';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import type { SearchResult } from '@doc/contracts';
import { api, label } from '../../../lib/client';
import { parseIndexedSummary, shortId } from '../../../lib/format';
import { PageTitle, Notice, Loading, Empty, Icon, Badge } from '../../../components/ui';

export default function Search() {
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState('hybrid');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams({ mode, limit: '50' });
    for (const [key, value] of form) {
      if (typeof value === 'string' && value.trim())
        query.set(key, key === 'currency' ? value.trim().toUpperCase() : value.trim());
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api<SearchResult>('search?' + query));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle
        title="Find the information you need."
        description="Search source text, use local semantic retrieval, or match invoice fields precisely."
      />

      <section className="panel search-panel">
        <div className="tabs" role="tablist" aria-label="Search mode">
          {[
            ['hybrid', 'Hybrid search'],
            ['keyword', 'Keyword'],
            ['semantic', 'Semantic'],
            ['filter', 'Invoice fields'],
          ].map(([value, title]) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              className={mode === value ? 'selected' : ''}
              onClick={() => {
                setMode(value!);
                setResult(null);
                setError('');
              }}
            >
              {title}
            </button>
          ))}
        </div>

        <form ref={formRef} onSubmit={submit}>
          <div className="search-main">
            <Icon name="search" size={20} />
            <label className="sr-only" htmlFor="search-query">Search query</label>
            <input
              id="search-query"
              name="q"
              placeholder={mode === 'filter' ? 'Optional text; use the invoice filters below' : 'Search documents in English or Bengali…'}
              required={mode !== 'filter'}
              disabled={mode === 'filter'}
              maxLength={500}
            />
            <button className="button" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
          </div>

          <div className="search-filters">
            <label>
              Invoice number
              <input name="invoice_number" placeholder="Exact invoice number" maxLength={200} />
            </label>
            <label>
              Supplier
              <input name="supplier" placeholder="Supplier name" maxLength={200} />
            </label>
            <label>
              Invoice date from
              <input name="date_from" type="date" />
            </label>
            <label>
              Invoice date to
              <input name="date_to" type="date" />
            </label>
            <label>
              Currency
              <input name="currency" placeholder="e.g. USD / BDT" maxLength={3} pattern="[A-Za-z]{3}" />
            </label>
            <label>
              Minimum total
              <input name="amount_min" inputMode="decimal" placeholder="No minimum" pattern="-?[0-9]{1,16}(\.[0-9]{1,8})?" />
            </label>
            <label>
              Maximum total
              <input name="amount_max" inputMode="decimal" placeholder="No maximum" pattern="-?[0-9]{1,16}(\.[0-9]{1,8})?" />
            </label>
          </div>

          <div className="search-footer">
            <p className="muted small-copy">
              {mode === 'filter'
                ? 'Provide at least one invoice filter. Amounts and currencies are matched against reported totals.'
                : mode === 'semantic'
                  ? 'Semantic search uses the active local embedding model. Unavailable models produce an explicit error.'
                  : mode === 'hybrid'
                    ? 'Combines PostgreSQL keyword ranking with local semantic similarity (RRF).'
                    : 'Matches source keywords with PostgreSQL full-text search.'}
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                formRef.current?.reset();
                setResult(null);
                setError('');
              }}
            >
              Reset fields
            </button>
          </div>
        </form>
      </section>

      {error && <Notice>{error}</Notice>}

      {busy ? (
        <Loading text="Searching your workspace…" />
      ) : result ? (
        <section className="panel search-results">
          <div className="panel-heading">
            <div>
              <h2>Search results</h2>
              <p className="tabular">{result.items.length} result(s) · up to 50 ranked matches</p>
            </div>
            <Badge value={result.mode} />
          </div>

          {!result.items.length ? (
            <Empty title="No matching records">
              Try different keywords or broaden your invoice filters. Text search requires a current published index.
            </Empty>
          ) : (
            result.items.map((item, index) => {
              const structured = parseIndexedSummary(item.text);
              return (
                <article key={item.id} className="search-result">
                  <span className="result-number tabular">{String(index + 1).padStart(2, '0')}</span>
                  <div className="result-content">
                    <div className="result-header">
                      <Link className="text-link result-title" href={'/documents/' + item.document_id + (item.invoice_id ? '?review=' + item.invoice_id : '')}>
                        {structured ? structured.heading : item.kind === 'invoice' ? 'Invoice ' + item.text : 'Document passage'}
                      </Link>
                      <span className="stage-chip">{label(item.kind)}</span>
                    </div>

                    {structured ? (
                      <div className="structured-snippet">
                        {structured.pairs.map(pair => (
                          <div key={pair.key} className="snippet-kv">
                            <span>{pair.key}</span>
                            <strong className="tabular">{pair.value}</strong>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="result-excerpt">{item.text}</p>
                    )}

                    <div className="result-meta">
                      <span className="mono id-chip" title={item.document_id}>Doc {shortId(item.document_id)}</span>
                      {item.source_reference.page_number !== undefined && (
                        <span className="meta-pill">Page {String(item.source_reference.page_number)}</span>
                      )}
                      {item.source_reference.worksheet !== undefined && item.source_reference.worksheet !== null && (
                        <span className="meta-pill">{String(item.source_reference.worksheet)}</span>
                      )}
                      {typeof item.score === 'number' && (
                        <span className="meta-pill tabular">Score {item.score.toFixed(3)}</span>
                      )}
                    </div>

                    <details>
                      <summary>Source references</summary>
                      <pre>{JSON.stringify(item.source_reference, null, 2)}</pre>
                    </details>
                  </div>
                  <Link className="icon-button" aria-label={'Open result ' + (index + 1)} href={'/documents/' + item.document_id}>
                    <Icon name="arrow" size={18} />
                  </Link>
                </article>
              );
            })
          )}
        </section>
      ) : (
        <Empty title="Your next answer starts here">
          Use words, invoice identifiers or financial filters to find a traceable source.
        </Empty>
      )}
    </>
  );
}
