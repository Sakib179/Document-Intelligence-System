import { Decimal } from 'decimal.js';
import type { FinancialRules } from '@doc/contracts';
// Products of NUMERIC(24,8) values and sums of at most 1,000 lines fit this precision.
export const Exact = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });
export type Amount = Decimal;
export const FINANCE_ENGINE_VERSION = 'finance-v1-icu-' + process.versions.icu;
// ICU omits these ISO 4217 indexed units from its circulating-currency enumeration.
const currencies = new Set([...Intl.supportedValuesOf('currency'), 'CLF', 'UYW']);
export function parseAmount(value: string | null): Amount | null {
  if (value === null || !/^-?\d{1,16}(?:\.\d{1,8})?$/.test(value))
    return null;
  const parsed = new Exact(value);
  return parsed.isFinite() ? parsed : null;
}
export function normalizeIdentity(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/gu, ' ');
}
export function normalizeSupplier(value: string | null): string {
  return normalizeIdentity(value).replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}
export function isCurrency(value: string | null): value is string { return value !== null && /^[A-Z]{3}$/.test(value) && currencies.has(value); }
export function validDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function currencyPolicy(currency: string | null, rules: FinancialRules) {
  if (!isCurrency(currency))
    return null;
  const override = rules.currency_overrides[currency];
  const digits = override?.minor_units ?? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!;
  const tolerance = new Exact(10).pow(-digits).times(override?.tolerance_minor_units ?? rules.tolerance_minor_units);
  const mode = rules.rounding_mode === 'half_even' ? Decimal.ROUND_HALF_EVEN : Decimal.ROUND_HALF_UP;
  return { digits, tolerance, round: (value: Amount) => value.toDecimalPlaces(digits, mode), format: (value: Amount) => value.toFixed(digits, mode) };
}
export type CurrencyPolicy = NonNullable<ReturnType<typeof currencyPolicy>>;
