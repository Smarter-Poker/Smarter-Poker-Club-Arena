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

/**
 * THE BOOKMARK MATRIX (Rule 8, "hostile environment testing").
 *
 * UnionSkinGuard ejects a player from /clubs/<union-hub>/* when
 * isConfirmedUnionClubId says true. A six-month-old bookmark is just that URL
 * arriving with whatever localStorage the browser still holds, so the guard's
 * answer has to survive every cache state a browser can present — not only
 * the pristine one.
 *
 * The last case is a deliberate asymmetry, recorded here so it can never be
 * mistaken for an oversight: on a dead network the guard does NOT eject.
 * Ejecting would throw real players out of their own club lobby on every
 * transient blip, so this direction fails OPEN. Destination PICKING fails the
 * other way — see the isUnionClubId cases in lobbyClubNeverUnion.test.ts — so
 * an unverifiable club is still never navigated TO.
 */
describe('an old bookmark to /clubs/<union-hub> survives every cache state', () => {
  const cases: Array<{ name: string; cache: unknown[] | null }> = [
    { name: 'no cache at all (fresh browser)', cache: null },
    {
      name: 'modern cache, union correctly flagged',
      cache: [{ id: UNION_HUB, name: 'Midway Union', club_id: 90001, is_union: true }],
    },
    {
      name: 'LEGACY cache row carrying no union signal',
      cache: [staleRow(UNION_HUB, 'Midway Union')],
    },
    {
      name: 'cache naming only a DIFFERENT club',
      cache: [{ id: SHARK, name: 'SHARK CLUB', club_id: 90002, is_union: false }],
    },
  ];

  for (const c of cases) {
    it(`ejects with ${c.name}`, async () => {
      if (c.cache) localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, JSON.stringify(c.cache));
      await expect(isConfirmedUnionClubId(UNION_HUB)).resolves.toBe(true);
    });
  }

  it('ejects even when the cache blob is corrupt, without throwing', async () => {
    localStorage.setItem(STORAGE_KEYS.CLUBS_CACHE, '{not json at all');
    await expect(isConfirmedUnionClubId(UNION_HUB)).resolves.toBe(true);
  });

  it('MID-FLIGHT DROP: will not eject on an unverifiable club, and still will not route to it', async () => {
    maybeSingleMock.mockImplementation(async () => ({
      data: null,
      error: { message: 'network' },
    }));
    // Fails OPEN: a blip must not evict a player from their own club lobby.
    await expect(isConfirmedUnionClubId(UNION_HUB)).resolves.toBe(false);
    // ...while the same blip still refuses to send anyone TO that club.
    await expect(
      resolveLobbyClubId({ viewerClubId: UNION_HUB, tableClubId: UNION_HUB })
    ).resolves.toBeNull();
  });
});
