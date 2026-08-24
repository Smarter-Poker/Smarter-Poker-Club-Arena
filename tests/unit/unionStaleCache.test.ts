/**
 * RULE 8 — HOSTILE STATE. A stale CLUBS_CACHE must not defeat the union guard.
 *
 * `CLUBS_CACHE` is written by HomePage and read by clubQuickLink with NO
 * freshness check. Entries written before `is_union` was selected carry neither
 * `is_union` nor `entity_type`. `isUnionEntity` answers false for those, so an
 * old cache row for the union hub club reads as an ordinary club — and the
 * answer is then memoised in unionFlagCache for the whole session.
 *
 * That defeats both halves of the fix at once: resolveLobbyClubId will hand
 * back the union as a lobby destination, and UnionSkinGuard will not eject a
 * player who arrives on /clubs/<union-hub>/... from an old bookmark.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const maybeSingleMock = vi.fn();
const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(() => ({ select: selectMock })) } }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ select: selectMock })) },
}));

import {
  resolveLobbyClubId,
  isConfirmedUnionClubId,
  clearUnionFlagCache,
} from '../../src/utils/clubQuickLink';
import { STORAGE_KEYS } from '../../src/lib/storage';

const UNION_HUB = 'ffffffff-0000-0000-0000-000000000001';
const SHARK = 'aaaaaaaa-0000-0000-0000-000000000002';

/** A cache row in the OLD shape: no is_union, no entity_type. */
const staleRow = (id: string, name: string) => ({ id, name, club_id: 90001 });

beforeEach(() => {
  localStorage.clear();
  clearUnionFlagCache();
  maybeSingleMock.mockReset();
  selectMock.mockClear();
  // The database still knows the truth.
  maybeSingleMock.mockImplementation(async () => ({ data: { is_union: true }, error: null }));
});

describe('a stale CLUBS_CACHE cannot smuggle a union through', () => {
  it('does not trust an old-shape cache row that carries no union signal', async () => {
    localStorage.setItem(
      STORAGE_KEYS.CLUBS_CACHE,
      JSON.stringify([staleRow(UNION_HUB, 'Midway Union')])
    );
    await expect(isConfirmedUnionClubId(UNION_HUB)).resolves.toBe(true);
  });

  it('never returns the union as a lobby destination from a stale cache', async () => {
    localStorage.setItem(
      STORAGE_KEYS.CLUBS_CACHE,
      JSON.stringify([staleRow(UNION_HUB, 'Midway Union')])
    );
    await expect(
      resolveLobbyClubId({ viewerClubId: UNION_HUB, tableClubId: UNION_HUB })
    ).resolves.toBeNull();
  });

  it('still trusts a MODERN cache row without hitting the network', async () => {
    localStorage.setItem(
      STORAGE_KEYS.CLUBS_CACHE,
      JSON.stringify([{ id: SHARK, name: 'SHARK CLUB', club_id: 90002, is_union: false }])
    );
    await expect(isConfirmedUnionClubId(SHARK)).resolves.toBe(false);
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });
});
