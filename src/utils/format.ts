/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED FORMAT UTILITIES — DRY helpers for formatting numbers, chips, time
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Previously copy-pasted across 8+ pages. Centralized here for consistency.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MONEY IS DISPLAYED ONE WAY (2026-09-10, law: tests/money-is-displayed-one-way.law.test.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 2026-09-08 audit counted 30+ distinct money formatters in src/: seven
 * truncating, fourteen rounding, four abbreviating and five with no fraction
 * options at all, so Intl's default of THREE decimals reached commission
 * screens and the same wallet balance read a cent apart on two pages. This
 * file is now the only place a chip amount is turned into text, and every
 * helper here obeys the same three rulings:
 *
 *   * Dan 2026-08-28: "CHIPS SHOULD ALWAYS BE DISPLAYED IN [WHOLE] NUMBERS,
 *     NEVER ROUNDED OR SHORTENED" - no K/M suffix, anywhere, ever. The
 *     lobby's `fmtChips` ("1.5K") was the last one and is gone.
 *   * Dan 2026-08-29: "THERE CAN NEVER BE 'ROUNDING' IT MUST ALWAYS BE DOWN
 *     TO THE CENT", and 2026-09-04: "ABSOLUTELY ZERO ROUNDING ANYWHERE EVER"
 *     - money truncates toward zero at the cent; a loss is never shown as
 *     break-even and a balance never gains a cent it does not hold.
 *   * CLAUDE.md 5.5: separators come from `toLocaleString`, never `padStart`.
 *
 * THE FAMILY, and which one a caller reaches for:
 *
 *   formatChips        money off the felt: wallets, cashier, ledger, prizes,
 *                      commissions, buy-ins. Always exactly two places.
 *   formatSignedChips  the same, with a leading + or - for a P/L.
 *   formatTableChips   chips ON the felt and on tournament clocks: integers
 *                      clean ("1,500"), a real fraction kept ("13.37").
 *   formatStackChips   a seat's stack: to the penny under 100, whole above.
 *   formatChipAward    the "+N" that rides with money arriving at a seat.
 *
 * Nothing else may call toLocaleString / Intl.NumberFormat / toFixed on a
 * chip amount. The law pins the set of files that still do (a ratchet that
 * only shrinks) and refuses any new one.
 */

/**
 * Format a number with locale-aware separators. COUNTS ONLY (hands, players,
 * entries). A chip amount goes through formatChips.
 * @example fmt(12345) → "12,345"
 */
export const fmt = (n: number | null | undefined): string => Number(n || 0).toLocaleString();

/**
 * CHIPS ON THE FELT ARE NEVER ABBREVIATED (Dan 2026-08-28, binding).
 *
 * The lobby's `fmtChips` rendered 117000 as "117.0K" and 247100 as "247.1K"
 * (it is gone now - see the header). On the TABLE that was never acceptable:
 * a player sizing a bet, or reading how much is behind, was being shown a
 * number that had been rounded away from the truth. "247K" is not a stack,
 * it is a range 500 chips wide.
 *
 * So: separators, never a K/M suffix, and never a rounded magnitude.
 *
 * IT ALSO DOES NOT ROUND THE FRACTION AWAY. An earlier pass at this floored
 * everything >= 1, which turned a typed 13.37 raise into "13" — the same
 * class of lie in the other direction, and it broke the bet-granularity spec
 * that pins the typed amount. Up to two decimals are kept WHEN THEY EXIST, so
 * integers (every tournament stack) stay clean and micro-stakes stay exact.
 *
 * A caller that genuinely wants whole chips — a transient animation label
 * carrying engine sub-chip noise — rounds before calling and says why. That
 * is a display choice about one number, not a second abbreviation policy.
 *
 * @example formatTableChips(117000)  → "117,000"
 * @example formatTableChips(247100)  → "247,100"
 * @example formatTableChips(13.37)   → "13.37"
 * @example formatTableChips(0.5)     → "0.50"
 */
/**
 * A STACK under 100 reads to the penny. Dan 2026-09-04, verbatim: "WHEN YOUR
 * ACCOUNT BALANCE ON CASH GAME TABLES IS UNDER 100 CHIPS IT SHOULD DISPLAY IT
 * AS 99.99 DOWN TO .01. IT NEEDS TO BE ACCURATE TO THE PENNY WHEN USERS HAVE
 * LESS THAN 100." A 0.02/0.05 stack of 5.37 was rendering as "5", because the
 * seat squared off every stack from 1 chip up. Under a hundred every chip is
 * pennies: two places, always, so 5 reads "5.00" beside 5.37 and the seats
 * line up. From 100 up a stack is whole chips (engine sub-chip noise is rake
 * and split artifacts, not chips anyone can bet) through formatTableChips.
 *
 * This is the STACK rule. Bets, pots and typed raises keep formatTableChips'
 * own contract (integers clean, real fractions kept).
 *
 * @example formatStackChips(5.37)   -> "5.37"
 * @example formatStackChips(5)      -> "5.00"
 * @example formatStackChips(99.99)  -> "99.99"
 * @example formatStackChips(117000) -> "117,000"
 */
export const PENNY_PRECISION_BELOW = 100;
export const formatStackChips = (n: number | null | undefined): string => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs < PENNY_PRECISION_BELOW) return `${v < 0 ? '-' : ''}${abs.toFixed(2)}`;
  return formatTableChips(Math.round(v));
};

export const formatTableChips = (n: number | null | undefined): string => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs < 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

/**
 * THE "+N" THAT RIDES WITH MONEY ARRIVING AT A SEAT (pot push, bounty,
 * insurance). Dan 2026-08-29, binding: "THERE CAN NEVER BE 'ROUNDING' IT MUST
 * ALWAYS BE DOWN TO THE CENT."
 *
 * Until 2026-09-04 this label was built inline as `Math.round(amount)` for
 * anything >= 1, so a 7.50 bounty floated up as "+8" while the seat's own
 * stack delta beside it said "+7.50" — two numbers for one payment. 401 of
 * the 7,508 bounties paid since 08-28 (5.3%) carried cents and every one of
 * them was shown rounded. Cash pots at penny stakes had the same problem.
 *
 * Rule: snap to cents FIRST (that kills engine float noise such as
 * 12.500000001, which is sub-cent and not money), then whole chips read as
 * whole chips and anything else keeps exactly two places. Same contract as
 * SeatSlot's stack delta, so the two labels for one payment always agree.
 *
 * @example formatChipAward(1234)    -> "+1,234"
 * @example formatChipAward(7.5)     -> "+7.50"
 * @example formatChipAward(0.25)    -> "+0.25"
 * @example formatChipAward(12.5000000001) -> "+12.50"
 * @example formatChipAward(0)       -> "+0"
 */
export const formatChipAward = (amount: number | null | undefined): string => {
  const v = Number(amount ?? 0);
  if (!Number.isFinite(v)) return '+0';
  // + 1e-7 before rounding: a binary double holds 17.955 as 17.95499999...,
  // so a bare Math.round(x * 100) lands a half-cent DOWN. That is the exact
  // defect the 2026-08-29 "payouts are exact to the cent" fix removed from
  // the payout math; the label must not reintroduce it. The nudge is seven
  // orders of magnitude below a cent, so it can only ever decide a tie.
  const cents = Math.round(Math.abs(v) * 100 + 1e-7);
  const sign = v < 0 ? '-' : '+';
  if (cents % 100 === 0) return `${sign}${(cents / 100).toLocaleString('en-US')}`;
  return `${sign}${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/**
 * Format a timestamp as a relative "time ago" string.
 * @example timeAgo("2026-03-17T10:00:00Z") → "2h ago"
 */
export const timeAgo = (ts: string | null | undefined): string => {
  if (!ts) return 'Never';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

/**
 * Format a date with year.
 * @example formatDate("2026-03-17T10:00:00Z") → "Mar 17, 2026"
 */
export const formatDate = (ts: string | null | undefined): string => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/**
 * Format a date without year (compact).
 * @example formatDateShort("2026-03-17T10:00:00Z") → "Mar 17"
 */
export const formatDateShort = (ts: string | null | undefined): string => {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
};

/**
 * Format a date with time (no year).
 * @example formatDateTime("2026-03-17T10:30:00Z") → "Mar 17, 10:30 AM"
 */
export const formatDateTime = (ts: string | null | undefined): string => {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Format percentage from a 0-1 decimal.
 * @example pct(0.253) → "25.3%"
 */
export const pct = (n: number | null | undefined): string =>
  `${((Number(n) || 0) * 100).toFixed(1)}%`;

/* ── Player identity surfaces (added 2026-09-04) ────────────────────────────
   Every stat the profile renders arrives as a raw ratio or float from
   `ca_player_stats_overview_v2`. Multiplying a ratio by 100 in JavaScript
   yields 1.6500000000000001, and that exact string was on the live profile
   hero next to "ROI". Nothing below lets a float reach the DOM unrounded.

   STANDING DIRECTIVE (Dan, 2026-09-04): "ABSOLUTELY ZERO ROUNDING ANYWHERE
   EVER". Every helper here TRUNCATES toward zero; none may print a figure the
   ledger never produced. */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Truncate toward zero to `digits` places, then print with exactly `digits`. */
/* Binary floats: 2183.7 * 100 is 218369.99999999997 and a bare trunc prints
   2,183.69 for a ledger figure of 2,183.70. Nudge one part in a billion toward
   the sign before truncating; exact decimals stay exact. */
const nudge = (v: number): number => v + Math.sign(v) * 1e-9;

const truncFixed = (value: number, digits: number): string => {
  const factor = 10 ** digits;
  return (Math.trunc(nudge(value) * factor) / factor).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
};

/** "32.9%" from a value that is ALREADY a percentage (x100). Truncated. */
export const formatPct = (value: unknown, digits = 1): string =>
  finite(value) ? `${truncFixed(value, digits)}%` : '0%';

/** "+1.6%" / "-3.2%" / "0.0%" - explicit sign because the reader is a P/L. */
export const formatSignedPct = (value: unknown, digits = 1): string => {
  if (!finite(value)) return '0.0%';
  const fixed = truncFixed(value, digits);
  return value > 0 ? `+${fixed}%` : `${fixed}%`;
};

/** A chip amount as a number, or null when it is not one. Numeric strings
 *  (ledger columns that arrive as text) count; "", null, NaN do not. */
const asMoney = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return finite(n) ? n : null;
};

/**
 * "+1,711.50" / "-2,183.70" / "0.00" - formatChips with a leading sign for a
 * P/L. The sign is taken from the TRUNCATED cents, so a -0.004 result reads
 * "0.00" and never "-0.00", and a -0.49 loss reads "-0.49", never "0".
 */
export const formatSignedChips = (value: unknown, digits = 2): string => {
  const n = asMoney(value);
  if (n === null) return (0).toFixed(digits);
  const factor = 10 ** digits;
  const cents = Math.trunc(nudge(n) * factor);
  const fixed = formatChips(Math.abs(cents) / factor, digits);
  if (cents > 0) return `+${fixed}`;
  if (cents < 0) return `-${fixed}`;
  return fixed;
};

/**
 * "1,711.50" - THE money formatter. Two places always, thousands separators,
 * truncated toward zero at the cent (never rounded), and a value that is not
 * a finite number - null, undefined, NaN, an empty string, a failed read -
 * prints "0.00" rather than "NaN" or "12.346". A numeric string (a ledger
 * column that arrives as text) is accepted as the number it spells.
 *
 * @example formatChips(1234.5)     → "1,234.50"
 * @example formatChips(12.3456)    → "12.34"
 * @example formatChips(1250000)    → "1,250,000.00"
 * @example formatChips(-0.49)      → "-0.49"
 * @example formatChips('2183.7')   → "2,183.70"
 * @example formatChips(NaN)        → "0.00"
 */
export const formatChips = (value: unknown, digits = 2): string => {
  const n = asMoney(value);
  if (n === null) return (0).toFixed(digits);
  const factor = 10 ** digits;
  const truncated = Math.trunc(nudge(n) * factor) / factor;
  // Math.trunc(-0.004 * 100) is -0, which toLocaleString prints as "-0.00".
  return (truncated === 0 ? 0 : truncated).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/** "1,412" - whole counts (truncated, never rounded up). */
export const formatCount = (value: unknown): string =>
  finite(value) ? Math.trunc(value).toLocaleString('en-US') : '0';

/*
 * REMOVED 2026-09-05: `formatRatio`. It had no caller. Every ratio on the
 * credential (BB/100, aggression factor, per-variant BB/100) needs a leading
 * sign, which this did not add, so the page used its own `signed(...)` around
 * a truncation and always would have. A tested export that nothing calls reads
 * as covered while being unreachable, which is worse than no export at all.
 */

/** "9.9h" / "48m" - hours played, compact, truncated. */
export const formatHours = (hours: unknown): string => {
  if (!finite(hours) || hours <= 0) return '0h';
  if (hours < 1) return `${Math.trunc(hours * 60)}m`;
  return `${truncFixed(hours, 1)}h`;
};

/**
 * "Just Now" / "12m Ago" / "3h Ago" / "2d Ago" / "Aug 30". Title Case because
 * it sits beside Title Case labels on the credential; null when unknown so
 * the caller can omit the plate instead of printing "Never".
 */
export const relativeTimeTitle = (
  iso: string | null | undefined,
  now = Date.now()
): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const m = Math.floor(Math.max(0, now - t) / 60000);
  if (m < 1) return 'Just Now';
  if (m < 60) return `${m}m Ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h Ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d Ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/** "Oct 2025" - one member-since format for every identity surface. */
export const formatMemberSince = (iso: string | null | undefined): string => {
  if (!iso) return 'Unknown';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

/** 1 -> "1st", 22 -> "22nd", 113 -> "113th"; "-" when there is no finish. */
export const ordinal = (n: unknown): string => {
  if (!finite(n) || n <= 0) return '-';
  const v = Math.trunc(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[v % 10] ?? 'th';
  return `${v}${suffix}`;
};
