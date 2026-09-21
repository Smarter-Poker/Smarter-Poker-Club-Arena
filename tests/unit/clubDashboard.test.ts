import { describe, it, expect } from 'vitest';
import {
  sinceForRange,
  rangeLabel,
  rankPlayers,
  formatChips,
  formatInt,
  formatSigned,
  csvEscape,
  leaderboardToCsv,
  formatAgo,
  isAuthzError,
  isLiveTableStatus,
  sortClubTables,
  tableStatusLabel,
  type RankablePlayer,
} from '../../src/utils/clubDashboard';

const mk = (over: Partial<RankablePlayer>): RankablePlayer => ({
  userId: over.userId ?? 'u',
  displayName: over.displayName ?? 'Player',
  totalProfit: over.totalProfit ?? 0,
  totalWon: over.totalWon ?? 0,
  handsPlayed: over.handsPlayed ?? 0,
  handsAttributed: over.handsAttributed ?? over.handsPlayed ?? 0,
  handsWon: over.handsWon ?? 0,
  biggestPotWon: over.biggestPotWon ?? 0,
  winRate: over.winRate ?? 0,
  rank: over.rank ?? 0,
});

describe('sinceForRange', () => {
  const now = Date.UTC(2026, 7, 19, 15, 30, 0); // 2026-08-19T15:30:00Z

  it('returns null for "all" so the RPC applies no lower bound', () => {
    expect(sinceForRange('all', now)).toBeNull();
  });

  it('anchors "today" to UTC midnight, matching how stat_date is bucketed', () => {
    expect(sinceForRange('today', now)).toBe('2026-08-19T00:00:00.000Z');
  });

  it('goes back exactly 7 and 30 days for week/month', () => {
    expect(sinceForRange('week', now)).toBe('2026-08-12T15:30:00.000Z');
    expect(sinceForRange('month', now)).toBe('2026-07-20T15:30:00.000Z');
  });

  it('never returns a future timestamp', () => {
    (['today', 'week', 'month'] as const).forEach((r) => {
      expect(new Date(sinceForRange(r, now)!).getTime()).toBeLessThanOrEqual(now);
    });
  });
});

describe('rangeLabel', () => {
  it('reads naturally in an empty state sentence', () => {
    expect(rangeLabel('all')).toBe('all time');
    expect(rangeLabel('week')).toBe('this week');
  });
});

describe('rankPlayers', () => {
  const players = [
    mk({ userId: 'a', totalProfit: 10, handsPlayed: 5, winRate: 50, biggestPotWon: 3 }),
    mk({ userId: 'b', totalProfit: 50, handsPlayed: 1, winRate: 10, biggestPotWon: 99 }),
    mk({ userId: 'c', totalProfit: -5, handsPlayed: 90, winRate: 80, biggestPotWon: 1 }),
  ];

  it('sorts by profit descending by default', () => {
    expect(rankPlayers(players, 'profit').map((p) => p.userId)).toEqual(['b', 'a', 'c']);
  });

  it('supports hands, win rate and biggest pot orderings', () => {
    expect(rankPlayers(players, 'hands').map((p) => p.userId)).toEqual(['c', 'a', 'b']);
    expect(rankPlayers(players, 'winrate').map((p) => p.userId)).toEqual(['c', 'a', 'b']);
    expect(rankPlayers(players, 'biggest').map((p) => p.userId)).toEqual(['b', 'a', 'c']);
  });

  it('ranks every player - horses are players too (CLAUDE.md 10.5) - nothing here filters one out', () => {
    // rankPlayers takes no filtering argument at all any more: there is no
    // way to call it that leaves a player off the board.
    expect(rankPlayers(players, 'profit')).toHaveLength(3);
    expect(rankPlayers(players, 'profit').map((p) => p.rank)).toEqual([1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const before = players.map((p) => p.userId);
    rankPlayers(players, 'hands');
    expect(players.map((p) => p.userId)).toEqual(before);
  });

  it('handles an empty roster', () => {
    expect(rankPlayers([], 'profit')).toEqual([]);
  });
});

describe('chip formatting', () => {
  it('always shows two decimals with thousands separators', () => {
    expect(formatChips(1234.5)).toBe('1,234.50');
    expect(formatInt(1234.9)).toBe('1,234');
  });

  it('truncates rather than rounds, so a loss never rounds into a win', () => {
    expect(formatChips(0.999)).toBe('0.99');
  });

  it('prefixes sign from the value, and does not emit "-0.00"', () => {
    expect(formatSigned(12.3)).toBe('+12.30');
    expect(formatSigned(-12.3)).toBe('-12.30');
    expect(formatSigned(0)).toBe('0.00');
    expect(formatSigned(-0.004)).toBe('0.00');
  });
});

describe('CSV export', () => {
  it('escapes quotes and commas in player names', () => {
    expect(csvEscape('Bob "The Rock", Jr')).toBe('"Bob ""The Rock"", Jr"');
  });

  it('neutralizes spreadsheet formulas in user-controlled string cells', () => {
    expect(csvEscape('=HYPERLINK("https://bad.example")')).toBe(
      '"\'=HYPERLINK(""https://bad.example"")"'
    );
    expect(csvEscape('+SUM(1,2)')).toBe('"\'+SUM(1,2)"');
    expect(csvEscape(-42)).toBe('"-42"');
  });

  it('emits a header plus one line per player', () => {
    const csv = leaderboardToCsv([
      mk({ userId: 'a', displayName: 'Ann', totalProfit: 12.5, handsPlayed: 3, rank: 1 }),
    ]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('rank,player,hands_played');
    expect(lines[0]).not.toContain('is_horse');
    expect(lines[1]).toContain('"Ann"');
    expect(lines[1]).toContain('12.5');
  });

  it('exports hands_attributed so the profit denominator travels with the data', () => {
    const csv = leaderboardToCsv([
      mk({ userId: 'a', displayName: 'Ann', handsPlayed: 10, handsAttributed: 7, rank: 1 }),
    ]);
    const [header, row] = csv.split('\n');
    const idx = header.split(',').indexOf('hands_attributed');
    expect(idx).toBeGreaterThan(-1);
    expect(row.split(',')[idx]).toBe('7');
  });

  it('produces only a header for an empty leaderboard', () => {
    expect(leaderboardToCsv([]).split('\n')).toHaveLength(1);
  });
});

describe('formatAgo', () => {
  const now = 1_700_000_000_000;

  it('reads as "just now" inside the first ten seconds', () => {
    expect(formatAgo(now - 3_000, now)).toBe('just now');
  });

  it('steps through seconds, minutes, hours and days', () => {
    expect(formatAgo(now - 30_000, now)).toBe('30s ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('never renders a negative age when clocks disagree', () => {
    expect(formatAgo(now + 60_000, now)).toBe('just now');
  });
});

describe('isAuthzError', () => {
  it('detects the membership rejection by code and by message', () => {
    expect(isAuthzError({ code: '42501' })).toBe(true);
    expect(isAuthzError({ message: 'not authorized for this club' })).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isAuthzError({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe(
      false
    );
    expect(isAuthzError(null)).toBe(false);
  });
});

describe('sortClubTables', () => {
  const t = (status: string, currentPlayers: number, createdAt: string) => ({
    status,
    currentPlayers,
    createdAt,
  });

  it('puts live tables above dead ones however old they are', () => {
    const out = sortClubTables([
      t('closed', 9, '2026-08-19T10:00:00Z'),
      t('running', 2, '2026-01-01T10:00:00Z'),
    ]);
    expect(out[0].status).toBe('running');
  });

  it('orders live tables by how full they are', () => {
    const out = sortClubTables([
      t('running', 2, '2026-08-19T10:00:00Z'),
      t('waiting', 7, '2026-08-19T09:00:00Z'),
    ]);
    expect(out[0].currentPlayers).toBe(7);
  });

  it('falls back to newest when liveness and seats tie', () => {
    const out = sortClubTables([
      t('running', 3, '2026-08-01T00:00:00Z'),
      t('running', 3, '2026-08-19T00:00:00Z'),
    ]);
    expect(out[0].createdAt).toBe('2026-08-19T00:00:00Z');
  });

  it('does not mutate the input', () => {
    const input = [t('closed', 1, '2026-08-01T00:00:00Z'), t('running', 1, '2026-08-02T00:00:00Z')];
    const before = input.map((x) => x.status);
    sortClubTables(input);
    expect(input.map((x) => x.status)).toEqual(before);
  });
});

describe('table status', () => {
  it('treats running/waiting/active as live', () => {
    expect(isLiveTableStatus('running')).toBe(true);
    expect(isLiveTableStatus('waiting')).toBe(true);
    expect(isLiveTableStatus('closed')).toBe(false);
    expect(isLiveTableStatus(null)).toBe(false);
  });

  it('labels known statuses and title-cases unknown ones', () => {
    expect(tableStatusLabel('running')).toBe('Running');
    expect(tableStatusLabel('closed')).toBe('Closed');
    expect(tableStatusLabel('paused')).toBe('Paused');
    expect(tableStatusLabel('')).toBe('Unknown');
  });
});
