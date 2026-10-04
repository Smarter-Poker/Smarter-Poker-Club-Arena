import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCachedLeaderboardEntries,
  LEADERBOARD_CACHE_MAX_RECORDS,
  LEADERBOARD_CACHE_PREFIX,
  LEADERBOARD_CACHE_TTL_MS,
  setCachedLeaderboardEntries,
} from '@/utils/leaderboardCache';
import type { LeaderboardEntry } from '@/services/LeaderboardService';

const NOW = new Date('2026-10-03T12:00:00Z');

function entry(index: number): LeaderboardEntry {
  return {
    rank: index + 1,
    userId: `user-${index}`,
    username: `Player ${index}`,
    value: index * 10,
    metric: 'profit',
    change: 0,
  };
}

function rawKey(key: string): string {
  return LEADERBOARD_CACHE_PREFIX + key;
}

describe('leaderboard session cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns a cold miss, then round-trips a fresh ranking record', () => {
    expect(getCachedLeaderboardEntries('club-a_profit_weekly_0')).toBeNull();

    const rows = [entry(0), entry(1)];
    setCachedLeaderboardEntries('club-a_profit_weekly_0', rows);

    expect(getCachedLeaderboardEntries('club-a_profit_weekly_0')).toEqual({
      version: 2,
      storedAt: NOW.getTime(),
      entries: rows,
    });
  });

  it('expires stale rows at the five-minute boundary and removes their stored record', () => {
    const key = rawKey('club-a_profit_weekly_0');
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        storedAt: NOW.getTime() - LEADERBOARD_CACHE_TTL_MS - 1,
        entries: [entry(0)],
      })
    );

    expect(getCachedLeaderboardEntries('club-a_profit_weekly_0')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('evicts future-dated rows so clock skew cannot extend the cache lifetime', () => {
    const key = rawKey('club-a_profit_weekly_0');
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        storedAt: NOW.getTime() + 1,
        entries: [entry(0)],
      })
    );

    expect(getCachedLeaderboardEntries('club-a_profit_weekly_0')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it.each([
    ['malformed JSON', '{broken'],
    [
      'old schema version',
      JSON.stringify({ version: 1, storedAt: NOW.getTime(), entries: [entry(0)] }),
    ],
    [
      'invalid row',
      JSON.stringify({ version: 2, storedAt: NOW.getTime(), entries: [{ rank: 1 }] }),
    ],
  ])('evicts %s instead of returning it', (_label, value) => {
    const key = rawKey('club-a_profit_weekly_0');
    sessionStorage.setItem(key, value);

    expect(getCachedLeaderboardEntries('club-a_profit_weekly_0')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('bounds records to the newest twenty and removes corrupt records without skipping neighbors', () => {
    for (let index = 0; index < LEADERBOARD_CACHE_MAX_RECORDS + 2; index += 1) {
      const key = `club-${index}_profit_weekly_0`;
      sessionStorage.setItem(
        rawKey(key),
        JSON.stringify({ version: 2, storedAt: NOW.getTime() - index - 1, entries: [entry(index)] })
      );
    }
    sessionStorage.setItem(rawKey('corrupt-a'), '{broken');
    sessionStorage.setItem(rawKey('corrupt-b'), '{also broken');

    setCachedLeaderboardEntries('club-new_profit_weekly_0', [entry(99)]);

    const keys = Object.keys(sessionStorage).filter((key) =>
      key.startsWith(LEADERBOARD_CACHE_PREFIX)
    );
    expect(keys).toHaveLength(LEADERBOARD_CACHE_MAX_RECORDS);
    expect(sessionStorage.getItem(rawKey('club-20_profit_weekly_0'))).toBeNull();
    expect(sessionStorage.getItem(rawKey('club-21_profit_weekly_0'))).toBeNull();
    expect(sessionStorage.getItem(rawKey('corrupt-a'))).toBeNull();
    expect(sessionStorage.getItem(rawKey('corrupt-b'))).toBeNull();
    expect(getCachedLeaderboardEntries('club-new_profit_weekly_0')?.entries).toEqual([entry(99)]);
  });

  it('treats blocked or quota-limited session storage as optional', () => {
    const unavailable = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
      key: () => null,
      get length() {
        return 0;
      },
    };
    vi.stubGlobal('sessionStorage', unavailable);

    expect(() => getCachedLeaderboardEntries('club-a_profit_weekly_0')).not.toThrow();
    expect(() => setCachedLeaderboardEntries('club-a_profit_weekly_0', [entry(0)])).not.toThrow();
  });
});
