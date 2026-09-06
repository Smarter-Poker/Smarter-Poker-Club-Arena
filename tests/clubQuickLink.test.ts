/**
 * Club quick link resolution — the single rule behind the lobby Cashier and
 * Marketplace tiles, keyboard shortcuts 4/5, and the in-cashier switcher.
 *
 * Chips are PER CLUB (club_members.chip_balance). Unions live in the `clubs`
 * table with is_union = true and DO have club_members rows, so every path
 * that lists "clubs" has to filter them out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Supabase chain used by the util: .from().select().eq().in()
const inMock = vi.fn();
const eqMock = vi.fn(() => ({ in: inMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ select: selectMock })) },
}));

import {
  eligibleQuickLinkClubs,
  eligibleCashierWallets,
  mergeCashierWalletDirectory,
  resolveCashierWallet,
  isUnionEntity,
  resolveTargetClub,
  readLastClubId,
  rememberLastClub,
  clubParamToUuid,
  readCachedQuickLinkClubs,
  writeCachedQuickLinkClubs,
  fetchClubChipBalances,
  fetchQuickLinkClubs,
  clearClubChipBalanceCache,
  CHIP_BALANCE_EVENTS,
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
/** A union whose NAME does not contain "union" — the lobby heuristic misses it. */
const U_FLAG = {
  id: 'eeeeeeee-0000-0000-0000-000000000005',
  name: 'Midway Alliance',
  club_id: 55556,
  is_union: true,
};
const USER = 'dddddddd-0000-0000-0000-000000000042';

beforeEach(() => {
  localStorage.clear();
  clearClubChipBalanceCache();
  inMock.mockReset();
  eqMock.mockClear();
  selectMock.mockClear();
  inMock.mockResolvedValue({ data: [], error: null });
});

describe('isUnionEntity', () => {
  it('detects unions by the authoritative is_union column', () => {
    expect(isUnionEntity(U_FLAG)).toBe(true);
  });

  it('detects unions by the lobby entity_type label', () => {
    expect(isUnionEntity(U)).toBe(true);
  });

  it('leaves ordinary clubs alone', () => {
    expect(isUnionEntity(A)).toBe(false);
  });
});

describe('eligibleQuickLinkClubs', () => {
  it('excludes unions flagged either way', () => {
    expect(eligibleQuickLinkClubs([A, U, U_FLAG, B])).toEqual([A, B]);
  });

  it('returns empty for empty input', () => {
    expect(eligibleQuickLinkClubs([])).toEqual([]);
  });
});

describe('eligibleCashierWallets', () => {
  it('includes every club wallet and only an owned union wallet', () => {
    expect(
      eligibleCashierWallets([A, { ...U_FLAG, is_owner: false }, { ...U, is_owner: true }, B])
    ).toEqual([A, { ...U, is_owner: true }, B]);
  });

  it('does not role-filter club wallets for the permitted cashier hierarchy', () => {
    const roles = ['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent'];
    const roleClubs = roles.map((role, index) => ({
      ...A,
      id: `aaaaaaaa-0000-0000-0000-00000000000${index + 1}`,
      role,
    }));
    expect(eligibleCashierWallets(roleClubs).map((club) => club.role)).toEqual(roles);
  });

  it('resolves an owned union when it is the requested wallet', () => {
    const owned = { ...U_FLAG, is_owner: true };
    expect(resolveCashierWallet([A, owned], owned.id)).toEqual(owned);
  });

  it('merges a canonical owned union without duplicating its legacy companion row', () => {
    const legacyUnion = { ...U_FLAG, is_owner: true, slug: 'legacy-slug' };
    const canonicalUnion = {
      ...U_FLAG,
      is_owner: true,
      entity_type: 'union' as const,
      slug: 'canonical-slug',
      union_id: U_FLAG.id,
    };

    expect(mergeCashierWalletDirectory([A, legacyUnion, B], [canonicalUnion])).toEqual([
      A,
      { ...legacyUnion, ...canonicalUnion },
      B,
    ]);
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
    expect(resolveTargetClub([U_FLAG, A], U_FLAG.id)).toEqual(A);
  });

  it('returns null when the user has no eligible clubs', () => {
    expect(resolveTargetClub([], null)).toBeNull();
    expect(resolveTargetClub([U], U.id)).toBeNull();
    expect(resolveTargetClub([U_FLAG], U_FLAG.id)).toBeNull();
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

describe('readCachedQuickLinkClubs', () => {
  it('returns the union-filtered cache only to the account that wrote it', () => {
    writeCachedQuickLinkClubs(USER, [A, U_FLAG, B]);
    expect(readCachedQuickLinkClubs(USER).map((c) => c.id)).toEqual([A.id, B.id]);
    expect(readCachedQuickLinkClubs('eeeeeeee-0000-0000-0000-000000000099')).toEqual([]);
    expect(readCachedQuickLinkClubs()).toEqual([]);
  });

  it('is empty on a cold, legacy-unscoped, or corrupt cache', () => {
    expect(readCachedQuickLinkClubs(USER)).toEqual([]);
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify([A, B]));
    expect(readCachedQuickLinkClubs(USER)).toEqual([]);
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '{not json');
    expect(readCachedQuickLinkClubs(USER)).toEqual([]);
  });
});

describe('fetchClubChipBalances', () => {
  it('maps club_members rows to a club_id -> balance map', async () => {
    inMock.mockResolvedValue({
      data: [
        { club_id: A.id, chip_balance: 1234.5 },
        { club_id: B.id, chip_balance: 0 },
      ],
      error: null,
    });
    const balances = await fetchClubChipBalances(USER);
    expect(balances).not.toBeNull();
    expect(balances!.get(A.id)).toBe(1234.5);
    expect(balances!.get(B.id)).toBe(0);
  });

  it('only counts active/approved memberships', async () => {
    await fetchClubChipBalances(USER);
    expect(inMock).toHaveBeenCalledWith('status', ['approved', 'active']);
  });

  it('memoizes within the TTL — second call does not requery', async () => {
    inMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 7 }], error: null });
    await fetchClubChipBalances(USER);
    await fetchClubChipBalances(USER);
    expect(inMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache is cleared by a chip movement', async () => {
    inMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 7 }], error: null });
    await fetchClubChipBalances(USER);
    clearClubChipBalanceCache();
    await fetchClubChipBalances(USER);
    expect(inMock).toHaveBeenCalledTimes(2);
  });

  it('returns NULL on a failed read with no cache — unknown is not zero', async () => {
    /* Cashier audit 2026-08-27: an empty map here flowed into
       `map.get(clubId) ?? 0`, telling the cashout modal the player has 0
       chips in the club and refusing every cashout locally. "Could not find
       out" and "has no chips" are different answers. */
    clearClubChipBalanceCache();
    inMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const balances = await fetchClubChipBalances(USER);
    expect(balances).toBeNull();
  });

  it('returns the STALE cache on a failed read when one exists — stale beats wrong-empty', async () => {
    clearClubChipBalanceCache();
    inMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 7 }], error: null });
    await fetchClubChipBalances(USER);
    // Age the cache past the 30s TTL so the next call REQUERIES...
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
    try {
      // ...and that query fails: the expired-but-present cache is the answer.
      inMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
      const balances = await fetchClubChipBalances(USER);
      expect(balances).not.toBeNull();
      expect(balances!.get(A.id)).toBe(7);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("never returns another user's cached balances when an account-switch read fails", async () => {
    const nextUser = 'dddddddd-0000-0000-0000-000000000043';
    inMock.mockResolvedValue({ data: [{ club_id: A.id, chip_balance: 7 }], error: null });
    await fetchClubChipBalances(USER);

    inMock.mockResolvedValue({ data: null, error: { message: 'next user read failed' } });
    const balances = await fetchClubChipBalances(nextUser);

    expect(balances).toBeNull();
    expect(inMock).toHaveBeenCalledTimes(2);
  });

  it('exposes the bus events that should invalidate it', () => {
    expect(CHIP_BALANCE_EVENTS).toContain('CASHIER_BALANCE_CHANGED');
    expect(CHIP_BALANCE_EVENTS).toContain('CHIPS_DISTRIBUTED');
  });
});

describe('fetchQuickLinkClubs', () => {
  it('unwraps joined club rows', async () => {
    inMock.mockResolvedValue({ data: [{ club: A }, { club: [B] }, { club: null }], error: null });
    const clubs = await fetchQuickLinkClubs(USER);
    expect(clubs.map((c) => c.id)).toEqual([A.id, B.id]);
  });

  it('filters out unions — they are club_members rows too', async () => {
    inMock.mockResolvedValue({ data: [{ club: A }, { club: U_FLAG }], error: null });
    const clubs = await fetchQuickLinkClubs(USER);
    expect(clubs.map((c) => c.id)).toEqual([A.id]);
  });

  it('selects the is_union flag so the filter can work', async () => {
    await fetchQuickLinkClubs(USER);
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining('is_union'));
  });

  it('restricts to active/approved memberships', async () => {
    await fetchQuickLinkClubs(USER);
    expect(inMock).toHaveBeenCalledWith('status', ['approved', 'active']);
  });

  it('de-duplicates repeated club rows', async () => {
    inMock.mockResolvedValue({ data: [{ club: A }, { club: A }], error: null });
    expect(await fetchQuickLinkClubs(USER)).toHaveLength(1);
  });

  it('returns empty list on error without throwing', async () => {
    inMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchQuickLinkClubs(USER)).toEqual([]);
  });
});

describe('clubParamToUuid', () => {
  it('passes a UUID through', () => {
    expect(clubParamToUuid(A.id)).toBe(A.id);
  });

  it('resolves a numeric club code via the cached club list', () => {
    writeCachedQuickLinkClubs(USER, [A, B]);
    expect(clubParamToUuid('22222', USER)).toBe(B.id);
    expect(clubParamToUuid('22222', 'eeeeeeee-0000-0000-0000-000000000099')).toBeNull();
  });

  it('drops numeric codes it cannot resolve', () => {
    expect(clubParamToUuid('99999')).toBeNull();
  });

  it('handles undefined and corrupt cache', () => {
    expect(clubParamToUuid(undefined)).toBeNull();
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '{not json');
    expect(clubParamToUuid('22222', USER)).toBeNull();
  });
});
