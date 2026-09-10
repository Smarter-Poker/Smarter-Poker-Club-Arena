import { formatChips as canonicalFormatChips, formatSignedChips } from './format';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB DASHBOARD — pure helpers
 * ═══════════════════════════════════════════════════════════════════════════════
 * Extracted from ClubDashboard.tsx so the range maths, leaderboard ordering and
 * CSV encoding are unit-testable without mounting the page.
 */

export type RangeId = 'today' | 'week' | 'month' | 'all';
export type SortId = 'profit' | 'hands' | 'winrate' | 'biggest';

export interface RankablePlayer {
  userId: string;
  displayName: string;
  isHorse: boolean;
  totalProfit: number;
  totalWon: number;
  handsPlayed: number;
  handsAttributed: number;
  handsWon: number;
  biggestPotWon: number;
  winRate: number;
  rank: number;
}

/**
 * Maps the Time Range filter to the `p_since` argument of the dashboard RPCs.
 * 'all' is null (no lower bound). 'today' is UTC midnight because the server
 * buckets stat_date in UTC — using local midnight would shift the boundary by
 * the viewer's offset and make "Today" disagree with the stats table.
 */
export function sinceForRange(range: RangeId, now: number = Date.now()): string | null {
  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case 'week':
      return new Date(now - 7 * 86400000).toISOString();
    case 'month':
      return new Date(now - 30 * 86400000).toISOString();
    case 'all':
    default:
      return null;
  }
}

/** Human-readable suffix for empty states and captions. */
export function rangeLabel(range: RangeId): string {
  return range === 'all' ? 'all time' : `this ${range}`;
}

/**
 * Filters horses out (optional) and orders the leaderboard, then assigns
 * contiguous ranks so rank always matches displayed position — ranking before
 * filtering would leave visible gaps like #1, #4, #7.
 */
export function rankPlayers<T extends RankablePlayer>(
  players: T[],
  sortBy: SortId,
  hideHorses: boolean
): T[] {
  const filtered = hideHorses ? players.filter((p) => !p.isHorse) : players;
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'hands':
        return b.handsPlayed - a.handsPlayed;
      case 'winrate':
        return b.winRate - a.winRate;
      case 'biggest':
        return b.biggestPotWon - a.biggestPotWon;
      case 'profit':
      default:
        return b.totalProfit - a.totalProfit;
    }
  });
  return sorted.map((p, i) => ({ ...p, rank: i + 1 }));
}

/**
 * Chip formatting: the canonical formatter (two decimals, truncated, never
 * rounds a loss into a win). Re-exported so the dashboard's import path keeps
 * working; there is no second implementation here.
 */
export function formatChips(num: number): string {
  return canonicalFormatChips(num);
}

export function formatInt(num: number): string {
  return Math.trunc(num).toLocaleString('en-US');
}

/**
 * Signed chip amount. The sign comes from the truncated cents, so a tiny
 * negative like -0.004 renders "0.00" rather than "-0.00".
 */
export function formatSigned(num: number): string {
  return formatSignedChips(num);
}

/** RFC4180-ish CSV escaping: wrap in quotes and double any embedded quote. */
export function csvEscape(value: unknown): string {
  let s = String(value ?? '');
  if (typeof value === 'string' && /^[\t ]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function leaderboardToCsv(players: RankablePlayer[]): string {
  const header = [
    'rank',
    'player',
    'is_horse',
    'hands_played',
    'hands_attributed',
    'hands_won',
    'win_rate_pct',
    'total_won',
    'profit',
    'biggest_pot_won',
  ];
  const lines = [
    header.join(','),
    ...players.map((p) =>
      [
        p.rank,
        csvEscape(p.displayName),
        p.isHorse,
        p.handsPlayed,
        p.handsAttributed,
        p.handsWon,
        p.winRate,
        p.totalWon,
        p.totalProfit,
        p.biggestPotWon,
      ].join(',')
    ),
  ];
  return lines.join('\n');
}

/**
 * Compact "how long ago" for the freshness line. Takes `now` explicitly so the
 * caller controls the tick and the function stays pure/testable.
 */
export function formatAgo(then: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Postgres raises 42501 when the caller is not a member of the club. */
export function isAuthzError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === '42501' || /not authorized for this club/i.test(e.message || '');
}

/** Live table statuses — a table can be 'running' while flagged deleted. */
export const LIVE_TABLE_STATUSES = ['running', 'waiting', 'active'] as const;

export function isLiveTableStatus(status: string | null | undefined): boolean {
  return LIVE_TABLE_STATUSES.includes((status || '') as (typeof LIVE_TABLE_STATUSES)[number]);
}

export interface SortableTable {
  status: string;
  currentPlayers: number;
  createdAt: string;
}

/**
 * Tables tab ordering: live first, then fullest, then newest. The underlying
 * query is ordered by created_at alone, which buries a running table beneath
 * dead ones — the opposite of what a club owner opens the tab to see.
 */
export function sortClubTables<T extends SortableTable>(tables: T[]): T[] {
  return [...tables].sort((a, b) => {
    const aLive = isLiveTableStatus(a.status) ? 1 : 0;
    const bLive = isLiveTableStatus(b.status) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    if (a.currentPlayers !== b.currentPlayers) return b.currentPlayers - a.currentPlayers;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

export function tableStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting';
    case 'active':
      return 'Active';
    case 'finished':
    case 'closed':
      return 'Closed';
    default:
      return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
  }
}
