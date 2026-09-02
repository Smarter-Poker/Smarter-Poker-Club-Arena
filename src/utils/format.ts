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
