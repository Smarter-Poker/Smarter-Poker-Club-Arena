import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLUB_DATA_CACHE_PREFIX,
  CLUB_DATA_CACHE_TTL_MS,
  clubDataQueryKey,
  readClubDataCache,
  removeClubDataCaches,
  writeClubDataCache,
} from '../../src/lib/clubDataCache';

describe('Club Data SWR cache', () => {
  beforeEach(() => sessionStorage.clear());

  it('is scoped to the user, club, and canonical query', () => {
    const query = clubDataQueryKey({ sort: 'fee', game: 'ALL', start: '2026-08-01' });
    expect(query).toBe('game=ALL&sort=fee&start=2026-08-01');
    writeClubDataCache('owner-1', 'club-1', query, { rows: [1] }, 100);

    expect(readClubDataCache('owner-1', 'club-1', query, 101)).toEqual({ rows: [1] });
    expect(readClubDataCache('owner-2', 'club-1', query, 101)).toBeNull();
    expect(readClubDataCache('owner-1', 'club-2', query, 101)).toBeNull();
  });

  it('removes expired or corrupt entries instead of painting them', () => {
    const query = 'games';
    writeClubDataCache('owner-1', 'club-1', query, { private: true }, 100);
    expect(
      readClubDataCache('owner-1', 'club-1', query, 100 + CLUB_DATA_CACHE_TTL_MS + 1)
    ).toBeNull();
    expect(Object.keys(sessionStorage)).toHaveLength(0);

    sessionStorage.setItem(`${CLUB_DATA_CACHE_PREFIX}owner-1:club-1:${query}`, '{bad');
    expect(readClubDataCache('owner-1', 'club-1', query)).toBeNull();
  });

  it('can invalidate every query for one club without touching another', () => {
    writeClubDataCache('owner-1', 'club-1', 'a', { value: 1 });
    writeClubDataCache('owner-1', 'club-1', 'b', { value: 2 });
    writeClubDataCache('owner-1', 'club-2', 'a', { value: 3 });

    removeClubDataCaches('owner-1', 'club-1');

    expect(readClubDataCache('owner-1', 'club-1', 'a')).toBeNull();
    expect(readClubDataCache('owner-1', 'club-2', 'a')).toEqual({ value: 3 });
  });
});

describe('expired entries do not accumulate', () => {
  beforeEach(() => sessionStorage.clear());

  /**
   * A read removes what it finds stale, so an entry never read again is never
   * removed. That was tolerable while the key was scope plus period; the rake
   * snapshot then put the SORT in its key and quadrupled the space, so an
   * operator cycling sorts across periods can strand dozens of dead snapshots,
   * each holding a page of rows, until the tab closes.
   */
  it('sweeps this club stale entries when something new is written', () => {
    writeClubDataCache('owner-1', 'club-1', 'sort=rake', { value: 1 }, 0);
    writeClubDataCache('owner-1', 'club-1', 'sort=name', { value: 2 }, 0);
    expect(readClubDataCache('owner-1', 'club-1', 'sort=name', 1)).toEqual({ value: 2 });

    // Long enough that both are dead, then write a third.
    const later = CLUB_DATA_CACHE_TTL_MS + 1;
    writeClubDataCache('owner-1', 'club-1', 'sort=cost', { value: 3 }, later);

    const prefix = `${CLUB_DATA_CACHE_PREFIX}owner-1:club-1:`;
    const left: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(prefix)) left.push(k);
    }
    expect(left, 'the two dead entries are still occupying the store').toHaveLength(1);
    expect(readClubDataCache('owner-1', 'club-1', 'sort=cost', later)).toEqual({ value: 3 });
  });

  it('leaves another club and another viewer alone', () => {
    writeClubDataCache('owner-1', 'club-1', 'q', { a: 1 }, 0);
    writeClubDataCache('owner-1', 'club-2', 'q', { a: 2 }, 0);
    writeClubDataCache('owner-2', 'club-1', 'q', { a: 3 }, 0);

    // A sweep for club-1 must not reach across the club or the viewer, or one
    // operator's page would evict another's.
    const later = CLUB_DATA_CACHE_TTL_MS + 1;
    writeClubDataCache('owner-1', 'club-1', 'fresh', { a: 4 }, later);

    expect(readClubDataCache('owner-1', 'club-2', 'q', later - 1)).toEqual({ a: 2 });
    expect(readClubDataCache('owner-2', 'club-1', 'q', later - 1)).toEqual({ a: 3 });
  });
});
