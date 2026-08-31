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
