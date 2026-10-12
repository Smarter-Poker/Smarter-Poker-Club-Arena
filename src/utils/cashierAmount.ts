/**
 * Chip amount helpers shared by the Trade cashier and its tests.
 *
 * They lived in src/pages/CashierTradePage.tsx until the regression review of
 * 2026-10-10 (G-06): a route module that exports plain functions next to its
 * component loses React Fast Refresh, so they sit here and the page imports
 * them.
 */

/**
 * THE FIGURE A USER CONFIRMS IS THE FIGURE THAT MOVES (launch audit
 * 2026-10-09, P-10). `fmt` floors to one decimal of K/M/B for head zones and
 * list rows, which is the console law. Inside a confirmation - the Send Out
 * total and its per-target rows, an Insufficient Chips refusal, the receipt
 * amount - the exact two-decimal figure prints instead, grouped by thousands:
 * 5 x 1,999.99 is "9,999.95", never "9.9K". Whole chips print whole.
 */
export function exactChipFigure(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const cents = Math.round(Math.abs(safe) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = safe < 0 && cents > 0 ? '-' : '';
  // Two cent digits by arithmetic: the Trade page's one padStart is its
  // mm:ss clock, and the role-scoping law counts call sites.
  return fraction === 0
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction < 10 ? '0' : ''}${fraction}`;
}

/**
 * Money is summed in CENTS (launch audit 2026-10-09, P-16). `0.1 + 0.2 - 0.3`
 * is 5.55e-17 in binary floating point, which `net` printed as "+0"; every
 * displayed sum on the Trade page goes through here so a figure can never carry
 * drift the ledger does not have.
 */
export function sumChips(values: Iterable<number>): number {
  let cents = 0;
  for (const value of values) cents += Math.round((Number(value) || 0) * 100);
  return cents / 100;
}

/**
 * "1,000" used to reach `Number()` as NaN and be refused as "Enter A Positive
 * Amount" - the message blamed the sign, not the comma (launch audit
 * 2026-10-09, P-20). Conventional thousands grouping is accepted and stripped;
 * any other comma is named for what it is. Same words as the classic cashier.
 */
export function parseTradeAmount(
  input: string
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = String(input ?? '').trim();
  const grouped = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed);
  const spelled = grouped ? trimmed.replace(/,/g, '') : trimmed;
  if (spelled.includes(',')) return { ok: false, error: 'Enter The Amount Without Commas' };
  const raw = spelled === '' ? NaN : Number(spelled);
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: 'Enter A Positive Amount' };
  // THE SPELLING, NOT THE FLOAT (regression review 2026-10-10, G-08). `Number`
  // reads "1e3" as 1000 and "0x10" as 16; the classic cashier refuses both on
  // the typed text (P-14), and so does this page now. Digits and at most two
  // decimals are the only spelling of a chip amount.
  if (!/^\d+(\.\d{1,2})?$/.test(spelled)) {
    return { ok: false, error: 'Enter The Amount As Digits, With Up To Two Decimals' };
  }
  return { ok: true, value: raw };
}
