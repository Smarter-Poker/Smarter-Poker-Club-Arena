/**
 * Club quick link resolution — the single rule behind the lobby Cashier and
 * Marketplace tiles, keyboard shortcuts 4/5, and the in-cashier switcher.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const eqMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: eqMock })),
    })),
  },
}));

import {
  eligibleQuickLinkClubs,
  resolveTargetClub,
  readLastClubId,
  rememberLastClub,
  clubParamToUuid,
  fetchClubChipBalances,
  fetchQuickLinkClubs,
  clearClubChipBalanceCache,
} from '../src/utils/clubQuickLink';
import { STORAGE_KEYS } from '../src/lib/storage';

const A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha', club_id: 11111 };
const B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bravo', club_id: 22222 };
const U = {
  id: 'cccccccc-0000-0000-0000-000000000003',
  name: 'Union',
  club_id: 55555,
  entity_type: 'union' as const,
};

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  eqMock.mockReset();
});

describe('eligibleQuickLinkClubs', () => {
  it('excludes unions', () => {
    expect(eligibleQuickLinkClubs([A, U, B])).toEqual([A, B]);
  });

  it('returns empty for empty input', () => {
    expect(eligibleQuickLinkClubs([])).toEqual([]);
  });
});

describe('resolveTargetClub', () => {
  it('prefers the last-visited club when still a member', () => {
    expect(resolveTargetClub([A, B], B.id)).toEqual(B);
  });

  it('falls back to the first club when last-visited is gone', () => {
    expect(resolveTargetClub([A, B], 'dddddddd-0000-0000-0000-000000000009')).toEqual(A);
  });

  it('never resolves to a union, even as last-visited', () => {
    expect(resolveTargetClub([U, A], U.id)).toEqual(A);
  });

  it('returns null when the user has no eligible clubs', () => {
    expect(resolveTargetClub([], null)).toBeNull();
    expect(resolveTargetClub([U], U.id)).toBeNull();
  });

  it('reads stored LAST_CLUB when no override is given', () => {
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, B.id);
    expect(resolveTargetClub([A, B])).toEqual(B);
  });
});

describe('rememberLastClub / readLastClubId', () => {
  it('round-trips a UUID', () => {
    rememberLastClub(A.id);
    expect(readLastClubId()).toBe(A.id);
  });

  it('refuses non-UUID values', () => {
    rememberLastClub('11111');
    expect(readLastClubId()).toBeNull();
  });
});

describe('fetchClubChipBalances', () => {
  const USER = 'dddddddd-0000-0000-0000-000000000042';

  it('maps club_members rows to a club_id → balance map', async () => {
    eqMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 1234.5 },
        { club_id: B.id, chip_balance: 0 },
      ],
      error: null,
    });
    const balances = await fetchClubChipBalances(USER);
    expect(balances.get(A.id)).toBe(1234.5);
    expect(balances.get(B.id)).toBe(0);
  });

  it('memoizes within the TTL — second call does not requery', async () => {
    eqMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 7 }], error: null });
    await fetchClubChipBalances(USER);
    await fetchClubChipBalances(USER);
    expect(eqMock).toHaveBeenCalledTimes(1);
  });

  it('returns empty map on query error without throwing', async () => {
    eqMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const balances = await fetchClubChipBalances(USER);
    expect(balances.size).toBe(0);
  });
});

describe('fetchQuickLinkClubs', () => {
  const USER = 'dddddddd-0000-0000-0000-000000000042';

  it('unwraps joined club rows', async () => {
    eqMock.mockResolvedValue({
      data: [{ club: A }, { club: [B] }, { club: null }],
      error: null,
    });
    const clubs = await fetchQuickLinkClubs(USER);
    expect(clubs.map((c) => c.id)).toEqual([A.id, B.id]);
  });

  it('returns empty list on error without throwing', async () => {
    eqMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchQuickLinkClubs(USER)).toEqual([]);
  });
});

describe('clubParamToUuid', () => {
  it('passes a UUID through', () => {
    expect(clubParamToUuid(A.id)).toBe(A.id);
  });

  it('resolves a numeric club code via the cached club list', () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    expect(clubParamToUuid('22222')).toBe(B.id);
  });

  it('drops numeric codes it cannot resolve', () => {
    expect(clubParamToUuid('99999')).toBeNull();
  });

  it('handles undefined and corrupt cache', () => {
    expect(clubParamToUuid(undefined)).toBeNull();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '{not json');
    expect(clubParamToUuid('22222')).toBeNull();
  });
});
