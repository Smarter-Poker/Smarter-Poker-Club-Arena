/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED FORMAT UTILITIES — DRY helpers for formatting numbers, chips, time
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Previously copy-pasted across 8+ pages. Centralized here for consistency.
 */

/**
 * Format a number with locale-aware separators.
 * @example fmt(12345) → "12,345"
 */
export const fmt = (n: number | null | undefined): string => Number(n || 0).toLocaleString();

/**
 * Format a chip amount with K/M abbreviation.
 * @example fmtChips(1500) → "1.5K"
 * @example fmtChips(2500000) → "2.5M"
 */
export const fmtChips = (n: number | null | undefined): string => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};

/**
 * CHIPS ON THE FELT ARE NEVER ABBREVIATED (Dan 2026-08-28, binding).
 *
 * `fmtChips` above renders 117000 as "117.0K" and 247100 as "247.1K". On a
 * lobby row that is fine — it is a browsing surface and the exact number does
 * not change a decision. On the TABLE it is not: a player sizing a bet, or
 * reading how much is behind, is being shown a number that has been rounded
 * away from the truth. "247K" is not a stack, it is a range 500 chips wide.
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
   hero next to "ROI". Nothing below lets a float reach the DOM unrounded. */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "32.9%" from a value that is ALREADY a percentage (x100). */
export const formatPct = (value: unknown, digits = 1): string =>
  finite(value) ? `${value.toFixed(digits)}%` : '0%';

/** "+1.7%" / "-3.2%" / "0.0%" - explicit sign because the reader is a P/L. */
export const formatSignedPct = (value: unknown, digits = 1): string => {
  if (!finite(value)) return '0.0%';
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}%` : `${fixed}%`;
};

/** "+1,711.50" / "-2,183.70" / "0.00" - chips, signed, thousands separators. */
export const formatSignedChips = (value: unknown, digits = 2): string => {
  if (!finite(value)) return '0.00';
  const fixed = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (value > 0) return `+${fixed}`;
  if (value < 0) return `-${fixed}`;
  return fixed;
};

/** "1,711.50" - chips, unsigned. */
export const formatChips = (value: unknown, digits = 2): string =>
  finite(value)
    ? value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : '0.00';

/** "1,412" - whole counts. */
export const formatCount = (value: unknown): string =>
  finite(value) ? Math.round(value).toLocaleString('en-US') : '0';

/** "-305.6" - BB/100, aggression factor and other ratios at fixed precision. */
export const formatRatio = (value: unknown, digits = 1): string =>
  finite(value) ? value.toFixed(digits) : (0).toFixed(digits);

/** "9.9h" / "48m" - hours played, compact. */
export const formatHours = (hours: unknown): string => {
  if (!finite(hours) || hours <= 0) return '0h';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
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
  const v = Math.round(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[v % 10] ?? 'th';
  return `${v}${suffix}`;
};
