// Conversion between integer minor units (DESIGN 3) and PayPal's decimal strings ("60.00").

export interface Money {
  currency: string;
  minor: number;
}

/** Decimal places PayPal uses per currency. Only the currencies this MVP can meet are listed. */
const EXPONENT: Readonly<Record<string, number>> = { USD: 2, JPY: 0 };

function exponentOf(currency: string): number {
  const exp = EXPONENT[currency];
  if (exp === undefined) throw new RangeError(`unsupported currency: ${currency}`);
  return exp;
}

export function toPayPalValue(money: Money): string {
  if (!Number.isSafeInteger(money.minor) || money.minor < 0) {
    throw new RangeError(`amount must be a non-negative integer in minor units, got ${money.minor}`);
  }
  const exp = exponentOf(money.currency);
  if (exp === 0) return String(money.minor);
  const digits = String(money.minor).padStart(exp + 1, '0');
  return `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** Strict parse: the value must have exactly the currency's decimal places. Returns null otherwise. */
export function fromPayPalValue(value: string, currency: string): number | null {
  const exp = exponentOf(currency);
  const pattern = exp === 0 ? /^(\d{1,15})$/ : new RegExp(`^(\\d{1,15})\\.(\\d{${exp}})$`);
  const m = pattern.exec(value);
  if (!m) return null;
  const minor = Number(`${m[1]}${m[2] ?? ''}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function toPayPalAmount(money: Money): { currency_code: string; value: string } {
  return { currency_code: money.currency, value: toPayPalValue(money) };
}

/** True when a PayPal amount object equals the expected money exactly. */
export function amountEquals(amount: { currency_code: string; value: string } | undefined, expected: Money): boolean {
  if (!amount || amount.currency_code !== expected.currency) return false;
  return fromPayPalValue(amount.value, expected.currency) === expected.minor;
}
