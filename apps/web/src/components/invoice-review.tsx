'use client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { FinancialCheck, FinancialInvoice } from '@doc/contracts';
import { api, useResource, date, label } from '../lib/client';
import { formatAmount, formatInputNumber, formatQuantity, formatTaxRate, formatFieldPath, parseAuditDiff } from '../lib/format';
import {
  CATEGORY_META,
  computeInvoiceVisualAnalytics,
  computeValidationAnalytics,
  describeCheck,
  describeValidationIssue,
} from '../lib/validation-copy';
import type { IssueCategory } from '../lib/validation-copy';
import type { AuditPage, ValidationHistory } from '../lib/types';
import { Badge, Empty, Icon, Loading, Notice, Pager } from './ui';
import { useUser } from './shell';

export const invoiceFields = [
  ['invoice_number', 'Invoice number'],
  ['invoice_date', 'Invoice date'],
  ['supplier_name', 'Supplier'],
  ['customer_name', 'Customer'],
  ['subtotal', 'Subtotal'],
  ['tax', 'Tax'],
  ['total', 'Total'],
  ['currency', 'Currency'],
] as const;

const METADATA_FIELDS = [
  ['invoice_number', 'Invoice number'],
  ['invoice_date', 'Invoice date'],
  ['supplier_name', 'Supplier'],
  ['customer_name', 'Customer'],
  ['currency', 'Currency'],
] as const;

const FINANCIAL_FIELDS = [
  ['subtotal', 'Subtotal'],
  ['tax', 'Tax'],
  ['total', 'Total'],
] as const;

export function InvoiceValues({ invoice, activeEvidenceKey, onEvidence }: {
  invoice: FinancialInvoice;
  activeEvidenceKey?: string | null;
  onEvidence: (value: unknown, key?: string) => void;
}) {
  const currency = invoice.currency;
  const visual = computeInvoiceVisualAnalytics(invoice);
  return (
    <>
      <div className="invoice-fields">
        <div className="financial-hero-grid">
          {FINANCIAL_FIELDS.map(([key, title]) => {
            const raw = invoice[key];
            const formatted = formatAmount(raw, currency);
            const active = activeEvidenceKey === key;
            return (
              <div key={key} className={'financial-stat-card ' + (key === 'total' ? 'is-total ' : '') + (active ? 'is-active' : '')}>
                <div className="stat-card-top">
                  <span className="stat-label">{title}</span>
                  {invoice.evidence[key] !== undefined && (
                    <button
                      type="button"
                      className={'evidence-button ' + (active ? 'active' : '')}
                      onClick={() => onEvidence(invoice.evidence[key], key)}
                    >
                      Source
                    </button>
                  )}
                </div>
                <div className="stat-value tabular" title={raw ?? undefined}>
                  {formatted !== null ? (
                    <>
                      {currency && <span className="currency-code">{currency}</span>}
                      <span>{formatted}</span>
                    </>
                  ) : (
                    <em className="missing-value">Not found</em>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="invoice-analytics-strip">
          <div className="analytics-chip-row">
            <span className="analytics-chip">
              <span className="chip-dot good" />
              <strong className="tabular">{visual.filledCoreFields}/{visual.totalCoreFields}</strong> core fields
            </span>
            <span className="analytics-chip">
              <strong className="tabular">{invoice.line_items.length}</strong> line item{invoice.line_items.length === 1 ? '' : 's'}
            </span>
            {visual.composition?.effectiveTaxPct && (
              <span className="analytics-chip">
                Tax ratio <strong className="tabular">{visual.composition.effectiveTaxPct}</strong>
              </span>
            )}
          </div>
          {visual.composition && (
            <div className="composition-wrap" aria-label="Subtotal and tax composition">
              <div className="composition-bar">
                <span className="comp-sub" style={{ width: visual.composition.subtotalPct + '%' }} />
                <span className="comp-tax" style={{ width: visual.composition.taxPct + '%' }} />
              </div>
              <div className="composition-legend tabular">
                <span><i className="legend-swatch sub" />Subtotal {visual.composition.subtotalPct}%</span>
                <span><i className="legend-swatch tax" />Tax {visual.composition.taxPct}%</span>
              </div>
            </div>
          )}
        </div>

        <dl className="metadata-grid">
          {METADATA_FIELDS.map(([key, title]) => {
            const active = activeEvidenceKey === key;
            return (
              <div key={key} className={'metadata-item ' + (active ? 'is-active' : '')}>
                <dt>
                  <span>{title}</span>
                  {invoice.evidence[key] !== undefined && (
                    <button
                      type="button"
                      className={'evidence-button ' + (active ? 'active' : '')}
                      onClick={() => onEvidence(invoice.evidence[key], key)}
                    >
                      Source
                    </button>
                  )}
                </dt>
                <dd className={key === 'invoice_number' || key === 'invoice_date' || key === 'currency' ? 'tabular' : undefined}>
                  {invoice[key] ?? <em className="missing-value">Not found</em>}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="subsection-heading">
        <div className="heading-with-badge">
          <h3>Line items</h3>
          <span className="count-pill tabular">{invoice.line_items.length} item{invoice.line_items.length === 1 ? '' : 's'}</span>
        </div>
        {Object.keys(visual.lineShares).length > 1 && (
          <span className="muted small-copy">Bars show share of line totals</span>
        )}
      </div>

      {invoice.line_items.length ? (
        <div className="table-scroll">
          <table className="compact-table financial-table">
            <thead>
              <tr>
                <th className="line-num-col">#</th>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Tax rate</th>
                <th className="num">Total</th>
                <th className="action-col">Source</th>
              </tr>
            </thead>
            <tbody>
              {invoice.line_items.map((line, idx) => {
                const active = activeEvidenceKey === 'line:' + line.id;
                const share = visual.lineShares[line.id];
                const isLargest = visual.largestLineId === line.id && invoice.line_items.length > 1;
                return (
                  <tr key={line.id} className={active ? 'row-active' : undefined}>
                    <td className="line-num-col muted tabular">{idx + 1}</td>
                    <td className="line-desc">
                      <div className="line-desc-title">
                        <span>{line.description ?? <em className="missing-value">Not found</em>}</span>
                        {isLargest && <span className="top-driver-tag">Top item</span>}
                      </div>
                      {share !== undefined && invoice.line_items.length > 1 && (
                        <div className="line-share-row">
                          <span className="line-share-track">
                            <span className={'line-share-fill ' + (isLargest ? 'is-top' : '')} style={{ width: Math.max(3, share) + '%' }} />
                          </span>
                          <span className="line-share-pct tabular">{share}%</span>
                        </div>
                      )}
                    </td>
                    <td className="num tabular" title={line.quantity ?? undefined}>{formatQuantity(line.quantity) ?? '—'}</td>
                    <td className="num tabular" title={line.unit_price ?? undefined}>{formatAmount(line.unit_price, currency) ?? '—'}</td>
                    <td className="num tabular" title={line.tax_rate ?? undefined}>{formatTaxRate(line.tax_rate) ?? '—'}</td>
                    <td className="num tabular strong-cell" title={line.line_total ?? undefined}>{formatAmount(line.line_total, currency) ?? '—'}</td>
                    <td className="action-col">
                      <button
                        type="button"
                        className={'evidence-button ' + (active ? 'active' : '')}
                        onClick={() => onEvidence(line.evidence, 'line:' + line.id)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No line items extracted">Missing values remain empty and require review.</Empty>
      )}
    </>
  );
}

function HealthRing({ pct, tone, awaiting }: { pct: number; tone: 'good' | 'warn' | 'danger' | 'info'; awaiting: boolean }) {
  const radius = 21;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = awaiting ? circumference : circumference * (1 - clamped / 100);
  return (
    <div className={'val-ring tone-' + tone} aria-label={awaiting ? 'Checks paused awaiting terms' : `Verification score ${clamped}%`}>
      <svg viewBox="0 0 52 52" width="52" height="52">
        <circle className="val-ring-bg" cx="26" cy="26" r={radius} />
        <circle
          className="val-ring-fg"
          cx="26"
          cy="26"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="val-ring-label tabular">{awaiting ? '—' : clamped + '%'}</span>
    </div>
  );
}

function checkStatusLabel(status: FinancialCheck['status']) {
  if (status === 'passed') return 'Passed';
  if (status === 'failed') return 'Mismatch';
  if (status === 'warning') return 'Rounding';
  return 'Needs terms';
}

export function ValidationPanel({ invoiceId, onTermsUpdated }: {
  invoiceId: string;
  onTermsUpdated?: () => void;
}) {
  const user = useUser();
  const resource = useResource<ValidationHistory>('invoices/' + invoiceId + '/validations', 5000);
  const [issuePage, setIssuePage] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<'all' | IssueCategory>('all');
  const [showLineChecks, setShowLineChecks] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  const invoice = resource.data?.invoice;
  const currentTerms = invoice?.terms;
  const [taxMode, setTaxMode] = useState<string>('exclusive');
  const [subtotalBasis, setSubtotalBasis] = useState<string>('net');
  const [lineBasis, setLineBasis] = useState<string>('net');
  const [taxScope, setTaxScope] = useState<string>('reported');
  const [charges, setCharges] = useState<string>('0');
  const [discounts, setDiscounts] = useState<string>('0');
  const [withholding, setWithholding] = useState<string>('0');
  const [adjustmentsComplete, setAdjustmentsComplete] = useState<boolean>(true);
  const [lineItemsComplete, setLineItemsComplete] = useState<boolean>(true);
  const [termsReason, setTermsReason] = useState<string>('');

  function openTermsForm() {
    if (currentTerms) {
      setTaxMode(currentTerms.tax_mode === 'unknown' ? 'exclusive' : currentTerms.tax_mode);
      setSubtotalBasis(currentTerms.subtotal_basis === 'unknown' ? 'net' : currentTerms.subtotal_basis);
      setLineBasis(currentTerms.line_amount_basis === 'unknown' ? 'net' : currentTerms.line_amount_basis);
      setTaxScope(currentTerms.tax_scope ?? 'reported');
      setCharges(formatInputNumber(currentTerms.charges, 2) || '0');
      setDiscounts(formatInputNumber(currentTerms.discounts, 2) || '0');
      setWithholding(formatInputNumber(currentTerms.withholding, 2) || '0');
      setAdjustmentsComplete(currentTerms.adjustments_complete || true);
      setLineItemsComplete(currentTerms.line_items_complete || true);
    }
    setActionError('');
    setActionSuccess('');
    setShowTerms(true);
  }

  function applyPreset(preset: 'exclusive' | 'inclusive' | 'exempt') {
    if (preset === 'exclusive') {
      setTaxMode('exclusive');
      setSubtotalBasis('net');
      setLineBasis('net');
      setTaxScope('reported');
    } else if (preset === 'inclusive') {
      setTaxMode('inclusive');
      setSubtotalBasis('gross');
      setLineBasis('gross');
      setTaxScope('reported');
    } else {
      setTaxMode('exempt');
      setSubtotalBasis('net');
      setLineBasis('net');
      setTaxScope('reported');
    }
    setCharges(charges || '0');
    setDiscounts(discounts || '0');
    setWithholding(withholding || '0');
    setAdjustmentsComplete(true);
    setLineItemsComplete(true);
  }

  async function runValidationOnly() {
    setBusy(true);
    setActionError('');
    setActionSuccess('');
    try {
      await api('invoices/' + invoiceId + '/validations', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ rules: {} }),
      });
      setActionSuccess('Financial validation completed.');
      resource.reload();
      onTermsUpdated?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Validation request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function submitTerms(event: FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    setBusy(true);
    setActionError('');
    setActionSuccess('');
    try {
      await api('invoices/' + invoiceId + '/financial-terms', {
        method: 'PATCH',
        body: JSON.stringify({
          revision: invoice.revision,
          reason: termsReason.trim() || 'Reviewer confirmed financial terms against original document',
          terms: {
            tax_mode: taxMode,
            subtotal_basis: subtotalBasis,
            line_amount_basis: lineBasis,
            tax_scope: taxScope,
            charges: charges.trim() || '0',
            discounts: discounts.trim() || '0',
            withholding: withholding.trim() || '0',
            adjustments_complete: adjustmentsComplete,
            line_items_complete: lineItemsComplete,
          },
        }),
      });
      await api('invoices/' + invoiceId + '/validations', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ rules: {} }),
      });
      setShowTerms(false);
      setTermsReason('');
      setActionSuccess('Financial terms confirmed and invoice revalidated.');
      resource.reload();
      onTermsUpdated?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update financial terms.');
    } finally {
      setBusy(false);
    }
  }

  const latestRun = resource.data?.runs[0] ?? null;
  const report = latestRun?.result ?? null;
  const writable = user.role !== 'reader';
  const currency = invoice?.currency;
  const analytics = report ? computeValidationAnalytics(report, currency) : null;
  const visual = invoice ? computeInvoiceVisualAnalytics(invoice) : null;

  const severityRank = { high: 3, medium: 2, low: 1 };
  const sortedIssues = [...(report?.issues ?? [])].sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
  const filteredIssues = categoryFilter === 'all'
    ? sortedIssues
    : sortedIssues.filter(item => describeValidationIssue(item).category === categoryFilter);
  const start = Math.min(issuePage * 6, Math.max(0, Math.floor((filteredIssues.length - 1) / 6) * 6));

  const lineChecks = report?.checks.filter(c => c.code === 'LINE_AMOUNT_MISMATCH') ?? [];
  const headerChecks = report?.checks.filter(c => c.code !== 'LINE_AMOUNT_MISMATCH') ?? [];
  const lineChecksPassed = lineChecks.filter(c => c.status === 'passed').length;
  const lineChecksFailed = lineChecks.filter(c => c.status === 'failed').length;
  const lineChecksWarning = lineChecks.filter(c => c.status === 'warning').length;
  const lineChecksSkipped = lineChecks.filter(c => c.status === 'skipped').length;
  const lineSummaryStatus: FinancialCheck['status'] = lineChecksFailed > 0
    ? 'failed'
    : lineChecksWarning > 0
      ? 'warning'
      : lineChecksPassed > 0 && lineChecksSkipped === 0
        ? 'passed'
        : 'skipped';

  return (
    <section className="validation-section">
      <div className="subsection-heading">
        <div className="heading-with-badge">
          <h3>Financial validation</h3>
          {resource.data && <Badge value={resource.data.financial_status ?? 'NOT_VALIDATED'} />}
        </div>
        {writable && invoice && (
          <div className="inline-actions">
            <button type="button" className="button secondary small" disabled={busy} onClick={() => showTerms ? setShowTerms(false) : openTermsForm()}>
              <Icon name="sliders" size={14} />{showTerms ? 'Hide terms' : 'Confirm terms'}
            </button>
            <button type="button" className="button secondary small" disabled={busy} onClick={() => void runValidationOnly()}>
              <Icon name="refresh" size={14} />Revalidate
            </button>
          </div>
        )}
      </div>

      {actionError && <Notice>{actionError}</Notice>}
      {actionSuccess && <Notice tone="success">{actionSuccess}</Notice>}

      {showTerms && writable && invoice && (
        <form onSubmit={submitTerms} className="terms-drawer">
          <div className="terms-drawer-header">
            <div>
              <strong>Confirm financial terms</strong>
              <p className="muted small-copy">Verify tax basis and adjustment completeness against the source document, then run deterministic math checks.</p>
            </div>
            <div className="preset-row">
              <span className="muted small-copy">Quick presets:</span>
              <button type="button" className="preset-chip" onClick={() => applyPreset('exclusive')}>Standard Tax-Exclusive</button>
              <button type="button" className="preset-chip" onClick={() => applyPreset('inclusive')}>Tax-Inclusive</button>
              <button type="button" className="preset-chip" onClick={() => applyPreset('exempt')}>Tax-Exempt</button>
            </div>
          </div>
          <div className="terms-grid">
            <label>
              Tax method
              <select value={taxMode} onChange={e => setTaxMode(e.target.value)}>
                <option value="exclusive">Exclusive (tax added to net subtotal)</option>
                <option value="inclusive">Inclusive (subtotal includes tax)</option>
                <option value="exempt">Exempt (zero tax)</option>
              </select>
            </label>
            <label>
              Subtotal basis
              <select value={subtotalBasis} onChange={e => setSubtotalBasis(e.target.value)}>
                <option value="net">Net (before tax)</option>
                <option value="gross">Gross (includes tax)</option>
              </select>
            </label>
            <label>
              Line item basis
              <select value={lineBasis} onChange={e => setLineBasis(e.target.value)}>
                <option value="net">Net line totals</option>
                <option value="gross">Gross line totals</option>
              </select>
            </label>
            <label>
              Tax verification scope
              <select value={taxScope} onChange={e => setTaxScope(e.target.value)}>
                <option value="reported">Reported header tax</option>
                <option value="line_items">Sum of line-item taxes</option>
              </select>
            </label>
            <label>
              Additional charges
              <input value={charges} onChange={e => setCharges(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Discounts
              <input value={discounts} onChange={e => setDiscounts(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Withholding
              <input value={withholding} onChange={e => setWithholding(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Verification reason
              <input value={termsReason} onChange={e => setTermsReason(e.target.value)} placeholder="Checked against source invoice" />
            </label>
          </div>
          <div className="terms-checks">
            <label className="checkbox-label">
              <input type="checkbox" checked={adjustmentsComplete} onChange={e => setAdjustmentsComplete(e.target.checked)} />
              <span>Charges, discounts &amp; withholding confirmed complete</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={lineItemsComplete} onChange={e => setLineItemsComplete(e.target.checked)} />
              <span>All applicable line items are present</span>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="button secondary small" disabled={busy} onClick={() => setShowTerms(false)}>Cancel</button>
            <button className="button small" disabled={busy}>{busy ? 'Validating…' : 'Confirm terms & revalidate'}</button>
          </div>
        </form>
      )}

      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <Notice>{resource.error}</Notice>
      ) : !latestRun || !report || !analytics ? (
        <p className="muted">No financial validation has been recorded.</p>
      ) : (
        <>
          {resource.data?.stale && (
            <Notice tone="info">Invoice values changed after this report ran. Click Revalidate to refresh math checks.</Notice>
          )}

          {/* 1. Financial Health Hero */}
          <div className={'val-hero tone-' + analytics.tone}>
            <HealthRing
              pct={analytics.scorePct}
              tone={analytics.tone}
              awaiting={analytics.evaluatedChecks === 0 && analytics.skippedChecks > 0}
            />
            <div className="val-hero-body">
              <div className="val-hero-top">
                <h4>{analytics.headline}</h4>
                <span className="muted small-copy tabular">
                  {date(latestRun.created_at)}
                </span>
              </div>
              <p>{analytics.subline}</p>
            </div>
          </div>

          {/* 2. Compact Analytics KPI Grid */}
          <div className="val-kpi-grid">
            <div className="val-kpi">
              <span className="val-kpi-label">Checks verified</span>
              <strong className="tabular">
                {analytics.evaluatedChecks > 0
                  ? `${analytics.passedChecks}/${analytics.totalChecks}`
                  : `0/${analytics.totalChecks}`}
              </strong>
              <div className="val-mini-bar" aria-hidden="true">
                {analytics.totalChecks > 0 ? (
                  <>
                    {analytics.passedChecks > 0 && <span className="seg good" style={{ width: (analytics.passedChecks / analytics.totalChecks) * 100 + '%' }} />}
                    {analytics.warningChecks > 0 && <span className="seg warn" style={{ width: (analytics.warningChecks / analytics.totalChecks) * 100 + '%' }} />}
                    {analytics.failedChecks > 0 && <span className="seg danger" style={{ width: (analytics.failedChecks / analytics.totalChecks) * 100 + '%' }} />}
                    {analytics.skippedChecks > 0 && <span className="seg muted" style={{ width: (analytics.skippedChecks / analytics.totalChecks) * 100 + '%' }} />}
                  </>
                ) : (
                  <span className="seg muted" style={{ width: '100%' }} />
                )}
              </div>
              <small className="tabular">
                {analytics.passedChecks} passed · {analytics.failedChecks} failed · {analytics.skippedChecks} paused
              </small>
            </div>

            <div className="val-kpi">
              <span className="val-kpi-label">Math accuracy</span>
              <strong className={'tabular ' + (analytics.failedChecks > 0 ? 'text-danger' : analytics.evaluatedChecks > 0 ? 'text-good' : '')}>
                {analytics.failedChecks > 0
                  ? `${analytics.failedChecks} mismatch${analytics.failedChecks === 1 ? '' : 'es'}`
                  : analytics.evaluatedChecks > 0
                    ? 'Exact match'
                    : 'Awaiting terms'}
              </strong>
              <small className="tabular">
                {analytics.largestVariance
                  ? `Max diff: ${formatAmount(analytics.largestVariance.difference, currency) ?? analytics.largestVariance.difference}${currency ? ' ' + currency : ''}`
                  : report.tolerance
                    ? `Tolerance: ±${formatAmount(report.tolerance, currency) ?? report.tolerance}${currency ? ' ' + currency : ''}`
                    : 'Set currency for tolerance'}
              </small>
            </div>

            <div className="val-kpi">
              <span className="val-kpi-label">Open findings</span>
              <strong className="tabular">{report.issues.length}</strong>
              <div className="severity-summary">
                {analytics.severityCounts.high > 0 && <span className="sev-pill high">{analytics.severityCounts.high} high</span>}
                {analytics.severityCounts.medium > 0 && <span className="sev-pill medium">{analytics.severityCounts.medium} med</span>}
                {analytics.severityCounts.low > 0 && <span className="sev-pill low">{analytics.severityCounts.low} low</span>}
                {report.issues.length === 0 && <span className="sev-pill good">Clean</span>}
              </div>
            </div>

            <div className="val-kpi">
              <span className="val-kpi-label">Data coverage</span>
              <strong className="tabular">{visual ? `${visual.completenessPct}%` : '—'}</strong>
              <small className="tabular">
                {visual ? `${visual.filledCoreFields}/${visual.totalCoreFields} fields · ${invoice?.line_items.length ?? 0} lines` : '—'}
              </small>
            </div>
          </div>

          {/* 3. Guided Terms Setup Callout when Terms Are Blocking Math */}
          {analytics.needsTermsSetup && writable && !showTerms && (
            <div className="val-setup-banner">
              <div className="val-setup-copy">
                <strong>Unlock full arithmetic verification in one step</strong>
                <p>
                  {analytics.skippedChecks > 0
                    ? `${analytics.skippedChecks} calculation check${analytics.skippedChecks === 1 ? ' is' : 's are'} waiting for tax treatment (Exclusive/Inclusive) and adjustment confirmation.`
                    : 'Confirm tax treatment and adjustment completeness to resolve setup items.'}
                </p>
              </div>
              <button type="button" className="button small" disabled={busy} onClick={openTermsForm}>
                <Icon name="sliders" size={14} />Confirm terms &amp; verify math
              </button>
            </div>
          )}

          {/* 4. Always-Visible Verification Checks Scoreboard */}
          {report.checks.length > 0 && (
            <div className="val-scoreboard">
              <div className="val-section-label">
                <span>Arithmetic checks</span>
                <span className="muted small-copy tabular">{report.checks.length} total</span>
              </div>
              <div className="val-checks-grid">
                {lineChecks.length > 0 && (
                  <div className={'val-check-card st-' + lineSummaryStatus}>
                    <div className="val-check-top">
                      <strong>Line-item math (Qty × Price)</strong>
                      <span className={'check-pill st-' + lineSummaryStatus}>
                        {lineSummaryStatus === 'passed'
                          ? `${lineChecksPassed}/${lineChecks.length} passed`
                          : lineSummaryStatus === 'failed'
                            ? `${lineChecksFailed} mismatch${lineChecksFailed === 1 ? '' : 'es'}`
                            : lineSummaryStatus === 'warning'
                              ? `${lineChecksWarning} rounding`
                              : `${lineChecksSkipped} needs terms`}
                      </span>
                    </div>
                    <p className="val-check-desc">Checks every row’s quantity × unit price against its printed total.</p>
                    <button
                      type="button"
                      className="text-button small-link"
                      onClick={() => setShowLineChecks(open => !open)}
                    >
                      {showLineChecks ? 'Hide per-line breakdown' : `Inspect all ${lineChecks.length} line check${lineChecks.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                )}

                {headerChecks.map((check, idx) => {
                  const info = describeCheck(check);
                  const expected = formatAmount(check.expected, currency) ?? check.expected;
                  const actual = formatAmount(check.actual, currency) ?? check.actual;
                  return (
                    <div key={check.code + idx} className={'val-check-card st-' + check.status}>
                      <div className="val-check-top">
                        <strong>{info.title}</strong>
                        <span className={'check-pill st-' + check.status}>{checkStatusLabel(check.status)}</span>
                      </div>
                      <p className="val-check-desc">{info.detail}</p>
                      {(expected || actual) ? (
                        <div className="val-check-nums tabular">
                          <span>Expected <strong>{expected ?? '—'}</strong></span>
                          <span>Reported <strong>{actual ?? '—'}</strong></span>
                        </div>
                      ) : (
                        <div className="val-check-nums muted">
                          <span>Confirm terms or fill missing fields to run</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {showLineChecks && lineChecks.length > 0 && (
                <div className="table-scroll val-line-checks-table">
                  <table className="compact-table financial-table">
                    <thead>
                      <tr>
                        <th>Line</th>
                        <th>Result</th>
                        <th className="num">Expected</th>
                        <th className="num">Reported</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineChecks.map((check, index) => (
                        <tr key={check.field + index}>
                          <td>{describeCheck(check).shortLabel}</td>
                          <td><span className={'check-pill st-' + check.status}>{checkStatusLabel(check.status)}</span></td>
                          <td className="num tabular">{formatAmount(check.expected, currency) ?? check.expected ?? '—'}</td>
                          <td className="num tabular">{formatAmount(check.actual, currency) ?? check.actual ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 5. Plain-English Grouped Findings */}
          {report.issues.length > 0 ? (
            <div className="val-findings">
              <div className="val-findings-bar">
                <span className="val-section-label">Detailed findings</span>
                <div className="val-filter-chips" role="group" aria-label="Filter findings by category">
                  <button
                    type="button"
                    className={'val-chip ' + (categoryFilter === 'all' ? 'active' : '')}
                    onClick={() => { setCategoryFilter('all'); setIssuePage(0); }}
                  >
                    All <span className="tabular">{report.issues.length}</span>
                  </button>
                  {(['math', 'data', 'terms', 'duplicates'] as const).map(cat => (
                    analytics.categoryCounts[cat] > 0 && (
                      <button
                        key={cat}
                        type="button"
                        className={'val-chip ' + (categoryFilter === cat ? 'active' : '')}
                        onClick={() => { setCategoryFilter(cat); setIssuePage(0); }}
                      >
                        {CATEGORY_META[cat].label} <span className="tabular">{analytics.categoryCounts[cat]}</span>
                      </button>
                    )
                  ))}
                </div>
              </div>

              <ul className="issue-list">
                {filteredIssues.slice(start, start + 6).map((issue, index) => {
                  const info = describeValidationIssue(issue);
                  const diffRaw = typeof issue.evidence?.difference === 'string' ? issue.evidence.difference : null;
                  const diffFmt = diffRaw ? (formatAmount(diffRaw, currency) ?? diffRaw) : null;
                  const showCompare = !info.hideValueCompare && (issue.expected !== null || issue.actual !== null);
                  return (
                    <li key={issue.code + issue.field + index} className={'issue-card sev-' + issue.severity}>
                      <span className={'severity ' + issue.severity} />
                      <div className="issue-body">
                        <div className="issue-header">
                          <strong>{info.title}</strong>
                          <div className="issue-tags">
                            <span className="issue-field-chip">{formatFieldPath(issue.field)}</span>
                            <span className={'sev-pill ' + issue.severity}>{issue.severity}</span>
                          </div>
                        </div>
                        <p className="issue-explanation">{info.explanation}</p>
                        {showCompare && (
                          <div className="issue-compare-grid tabular">
                            <div className="compare-box">
                              <span>Expected</span>
                              <strong>{formatAmount(issue.expected, currency) ?? issue.expected ?? '—'}</strong>
                            </div>
                            <div className="compare-box">
                              <span>Reported</span>
                              <strong>{formatAmount(issue.actual, currency) ?? issue.actual ?? '—'}</strong>
                            </div>
                            {diffFmt && (
                              <div className="compare-box is-diff">
                                <span>Difference</span>
                                <strong>{diffFmt}{currency ? ' ' + currency : ''}</strong>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="issue-footer-row">
                          <span className="issue-action-hint">{info.action}</span>
                          <code className="issue-code-tag">{issue.code}</code>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {filteredIssues.length > 6 && (
                <div className="issue-pagination">
                  <span className="tabular">Showing {start + 1}–{Math.min(start + 6, filteredIssues.length)} of {filteredIssues.length} findings</span>
                  <div>
                    <button type="button" className="text-button" disabled={start === 0} onClick={() => setIssuePage(Math.max(0, issuePage - 1))}>Previous</button>
                    <button type="button" className="text-button" disabled={start + 6 >= filteredIssues.length} onClick={() => setIssuePage(issuePage + 1)}>Next</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Notice tone={resource.data?.stale ? 'info' : 'success'}>
              All deterministic financial checks passed with no discrepancies.
            </Notice>
          )}
        </>
      )}
    </section>
  );
}

function toEditableHeaderFields(inv: FinancialInvoice): Record<string, string> {
  return Object.fromEntries(
    invoiceFields.map(([key]) => {
      const raw = inv[key];
      if (key === 'subtotal' || key === 'tax' || key === 'total') return [key, formatInputNumber(raw, 2)];
      return [key, raw ?? ''];
    }),
  );
}

function toEditableLines(inv: FinancialInvoice) {
  return inv.line_items.map(line => ({
    ...line,
    quantity: line.quantity !== null ? formatInputNumber(line.quantity, 2) : null,
    unit_price: line.unit_price !== null ? formatInputNumber(line.unit_price, 2) : null,
    tax_rate: line.tax_rate !== null ? formatInputNumber(line.tax_rate, 4) : null,
    line_total: line.line_total !== null ? formatInputNumber(line.line_total, 2) : null,
  }));
}

export function InvoiceReview({ invoice, onSaved, onCancel, onDirty }: {
  invoice: FinancialInvoice;
  onSaved: () => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const user = useUser();
  const [base] = useState(invoice);
  const [initialFields] = useState<Record<string, string>>(() => toEditableHeaderFields(invoice));
  const [initialLines] = useState(() => toEditableLines(invoice));
  const [fields, setFields] = useState<Record<string, string>>(() => toEditableHeaderFields(invoice));
  const [lines, setLines] = useState(() => toEditableLines(invoice));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const writable = user.role !== 'reader';

  const changedHeaderCount = invoiceFields.filter(([key]) => (fields[key] ?? '') !== (initialFields[key] ?? '')).length;
  const changedLineCount = lines.filter(line => {
    const original = initialLines.find(item => item.id === line.id);
    if (!original) return false;
    return (['description', 'quantity', 'unit_price', 'tax_rate', 'line_total'] as const).some(key => line[key] !== original[key]);
  }).length;
  const totalChanges = changedHeaderCount + changedLineCount;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const changes = Object.fromEntries(
      invoiceFields
        .filter(([key]) => (fields[key] ?? '') !== (initialFields[key] ?? ''))
        .map(([key]) => [key, fields[key] || null]),
    );
    const line_items = lines.flatMap(line => {
      const original = initialLines.find(item => item.id === line.id)!;
      const lineChanges = Object.fromEntries((['description', 'quantity', 'unit_price', 'tax_rate', 'line_total'] as const).filter(key => line[key] !== original[key]).map(key => [key, line[key]]));
      return Object.keys(lineChanges).length ? [{ id: line.id, revision: line.revision, changes: lineChanges }] : [];
    });
    if (!Object.keys(changes).length && !line_items.length) {
      setError('Change a field before saving.');
      return;
    }
    if (line_items.length > 20) {
      setError('Save up to 20 line corrections at a time.');
      return;
    }
    setBusy(true);
    try {
      await api('invoices/' + base.id, {
        method: 'PATCH',
        body: JSON.stringify({
          revision: base.revision,
          ...(Object.keys(changes).length ? { changes } : {}),
          ...(line_items.length ? { line_items } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      onDirty(false);
      onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Correction failed.');
    } finally {
      setBusy(false);
    }
  }

  const displayOrig = (key: string, val: string | null | undefined) => {
    if (val === null || val === undefined || val === '') return 'Not found';
    if (['subtotal', 'tax', 'total', 'unit_price', 'line_total'].includes(key)) return formatAmount(val, base.currency) ?? val;
    if (key === 'quantity') return formatQuantity(val) ?? val;
    if (key === 'tax_rate') return formatTaxRate(val) ?? val;
    return val;
  };

  return (
    <form onSubmit={submit} className="review-form">
      <div className="review-intro">
        <div>
          <h3>Correct with confidence.</h3>
          <p>Original extracted values are preserved. Saving records your identity and schedules revalidation and indexing.</p>
        </div>
        {totalChanges > 0 && <span className="change-counter">{totalChanges} unsaved edit{totalChanges === 1 ? '' : 's'}</span>}
      </div>

      {!writable && <Notice tone="info">Your account has read-only access.</Notice>}
      {invoice.revision !== base.revision && <Notice>A newer revision exists. Cancel and reload before saving.</Notice>}
      {error && <Notice>{error}</Notice>}

      <div className="field-comparison-header">
        <span>Field / corrected value</span>
        <span>Original extraction</span>
      </div>

      {invoiceFields.map(([key, title]) => {
        const modified = (fields[key] ?? '') !== (initialFields[key] ?? '');
        const origRaw = base.original_values[key];
        return (
          <div className={'field-comparison ' + (modified ? 'is-modified' : '')} key={key}>
            <label>
              <span className="field-label-row">
                {title}
                {modified && <span className="modified-pill">Edited</span>}
              </span>
              <input
                aria-label={title}
                type={key === 'invoice_date' ? 'date' : 'text'}
                inputMode={['subtotal', 'tax', 'total'].includes(key) ? 'decimal' : undefined}
                value={fields[key]}
                readOnly={!writable}
                disabled={busy}
                onChange={event => {
                  setFields(values => ({ ...values, [key]: event.target.value }));
                  onDirty(true);
                }}
                maxLength={['subtotal', 'tax', 'total'].includes(key) ? 26 : key === 'currency' ? 3 : 500}
              />
            </label>
            <span className="original-value tabular" title={origRaw ?? undefined}>
              {displayOrig(key, origRaw)}
            </span>
          </div>
        );
      })}

      <div className="subsection-heading">
        <h3>Line-item corrections</h3>
        <span className="count-pill tabular">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
      </div>
      <p className="muted small-copy">Tax rates are normalized fractions (for example 0.15 for 15%). Blank fields remain unknown.</p>

      <div className="table-scroll">
        <table className="compact-table editable-lines">
          <thead>
            <tr>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit price</th>
              <th>Tax rate</th>
              <th>Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.id}>
                {(['description', 'quantity', 'unit_price', 'tax_rate', 'line_total'] as const).map(key => (
                  <td key={key}>
                    <input
                      aria-label={'Line ' + (index + 1) + ' ' + key.replaceAll('_', ' ')}
                      value={line[key] ?? ''}
                      readOnly={!writable}
                      disabled={busy}
                      onChange={event => {
                        setLines(values => values.map(item => item.id === line.id ? { ...item, [key]: event.target.value || null } : item));
                        onDirty(true);
                      }}
                    />
                    <small className="tabular" title={line.original_values[key] ?? undefined}>
                      Original: {displayOrig(key, line.original_values[key])}
                    </small>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label className="reason-field">
        Correction reason <span className="muted">(optional)</span>
        <textarea
          value={reason}
          maxLength={2000}
          disabled={busy || !writable}
          onChange={event => setReason(event.target.value)}
          placeholder="What did you check, and why did this value change?"
        />
      </label>

      <div className="form-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setFields({ ...initialFields });
            setLines(initialLines.map(line => ({ ...line })));
            setReason('');
            setError('');
            onDirty(false);
            onCancel();
          }}
        >
          Cancel / reload
        </button>
        <button className="button" disabled={busy || !writable || invoice.revision !== base.revision}>
          {busy ? 'Saving correction…' : 'Save corrections'}
        </button>
      </div>
    </form>
  );
}

export function AuditHistory({ invoiceId }: {
  invoiceId: string;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const resource = useResource<AuditPage>('invoices/' + invoiceId + '/history?limit=10' + (cursors.at(-1) ? '&cursor=' + encodeURIComponent(cursors.at(-1)!) : ''));

  return (
    <>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <Notice>{resource.error}</Notice>
      ) : !resource.data?.items.length ? (
        <Empty title="No audit events">Recorded changes will appear here.</Empty>
      ) : (
        <ol className="audit-list">
          {resource.data.items.map(event => {
            const diffs = parseAuditDiff(event.before_json, event.after_json);
            return (
              <li key={event.id} className="audit-card">
                <div className="subsection-heading">
                  <div className="heading-with-badge">
                    <strong>{label(event.event_type)}</strong>
                    <span className="stage-chip">{event.entity_table === 'invoice_line_items' ? 'Line item' : 'Invoice'}</span>
                  </div>
                  <time className="tabular">{date(event.created_at)}</time>
                </div>
                <p className="audit-reason">{event.reason ?? 'No supplied reason'}</p>
                <small className="muted audit-actor">
                  Actor: {event.actor_user_id ? (event.actor_name ?? 'User') + ' · ' + event.actor_user_id : 'System workflow'}
                </small>

                {diffs.length > 0 && (
                  <div className="diff-pills">
                    {diffs.map(diff => (
                      <div key={diff.field} className="diff-row">
                        <span className="diff-field">{diff.label}</span>
                        <span className="diff-before tabular">{diff.before}</span>
                        <span className="diff-arrow" aria-hidden="true">→</span>
                        <span className="diff-after tabular">{diff.after}</span>
                      </div>
                    ))}
                  </div>
                )}

                <details>
                  <summary>Original and changed values</summary>
                  <div className="audit-values">
                    <div>
                      <strong>Before</strong>
                      <pre>{event.before_json ?? 'No previous record'}</pre>
                    </div>
                    <div>
                      <strong>After</strong>
                      <pre>{event.after_json ?? 'No new record'}</pre>
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      <Pager
        canPrevious={cursors.length > 0}
        hasNext={!!resource.data?.next_cursor}
        onPrevious={() => setCursors(values => values.slice(0, -1))}
        onNext={() => {
          if (resource.data?.next_cursor) setCursors(values => [...values, resource.data!.next_cursor!]);
        }}
      />
    </>
  );
}
