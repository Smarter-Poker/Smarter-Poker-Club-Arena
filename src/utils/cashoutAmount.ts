/** Cashout request values follow fn_cashout_request's exact-hundredths limit. */
export const CASHOUT_AMOUNT_LIMIT = 1_000_000_000;
type CashoutAmount = { ok: true; amount: number; cents: number } | { ok: false; error: string };

export function validateCashoutAmount(input: number | string): CashoutAmount {
  const text = typeof input === 'string' ? input.trim() : null;
  const amount = typeof input === 'number' ? input : Number(text);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter An Amount Greater Than Zero' };
  }
  // Inspect the original spelling before Number can erase hidden sub-cent digits.
  if (text !== null) {
    const decimal = /^\+?(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:e([+-]?[0-9]+))?$/i.exec(text);
    const exponent = Number(decimal?.[4] ?? 0);
    if (!decimal || !Number.isSafeInteger(exponent)) {
      return { ok: false, error: 'Enter An Amount In Whole Cents' };
    }
    const fraction = decimal[2] ?? decimal[3] ?? '';
    const digits = (decimal[1] ?? '') + fraction;
    const subcentPlaces = fraction.length - exponent - 2;
    if (
      subcentPlaces > 0 &&
      /[1-9]/.test(digits.slice(Math.max(0, digits.length - subcentPlaces)))
    ) {
      return { ok: false, error: 'Enter An Amount In Whole Cents' };
    }
  }
  if (amount > CASHOUT_AMOUNT_LIMIT) {
    return { ok: false, error: 'Amount Exceeds The Single Request Limit' };
  }
  const cents = Math.round(amount * 100);
  // Comparison validates; it never replaces the requested value with a rounded one.
  if (!Number.isSafeInteger(cents) || cents / 100 !== amount) {
    return { ok: false, error: 'Enter An Amount In Whole Cents' };
  }
  return { ok: true, amount, cents };
}

/** Presets select a new value by rounding down at the cent, never typed input. */
export function cashoutPercentage(balance: number, percent: 25 | 50 | 100): string | null {
  const valid = validateCashoutAmount(balance);
  if (!valid.ok) return null;
  const cents = Math.floor((valid.cents * percent) / 100);
  return cents > 0 ? (cents / 100).toFixed(2) : null;
}
