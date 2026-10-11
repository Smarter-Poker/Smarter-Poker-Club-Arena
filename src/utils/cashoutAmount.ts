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
  // PLAIN DECIMAL DIGITS ONLY (cashier launch B-4, 2026-10-11). `Number` reads
  // "1e3" as 1,000, "+5" as 5 and "0x10" as 16, so an amount typed in any of
  // those spellings asked to cash out a figure nobody typed. The typed text is
  // digits with an optional decimal part, the same rule the Trade and classic
  // cashiers apply (src/utils/cashierAmount.ts, parseChipAmount); trailing
  // zeros past the cents are exact and stay accepted.
  if (text !== null) {
    const decimal = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))$/.exec(text);
    if (!decimal) {
      return { ok: false, error: 'Enter The Amount As Digits, With Up To Two Decimals' };
    }
    const fraction = decimal[2] ?? decimal[3] ?? '';
    if (/[1-9]/.test(fraction.slice(2))) {
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
