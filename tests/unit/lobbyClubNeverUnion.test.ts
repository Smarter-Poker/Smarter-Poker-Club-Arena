/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UNION LAW — the lobby a seated player lands in is NEVER a union
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23: "if I'm playing inside a club, SHARK CLUB or MIDWAY CLUB, and
 * I click the + button and go to the lobby, it should never ever ever take me
 * to the MIDWAY UNION lobby... players, agents, super agents, nobody should
 * ever see the union skins."
 *
 * They did. A union's games hang off the union's own HUB CLUB — a `clubs` row
 * with is_union = true, sharing the union's name — so `tables.club_id` on a
 * union game IS the union. Every "back to the lobby" path read that column raw:
 *
 *   • the in-table "+"            (MultiTablePage renders <ClubHomePage> for it)
 *   • MultiTablePage.goToLobby()  (last tab closed)
 *   • TablePage.exitDestination() (leave / bust / seat release)
 *
 * so a SHARK CLUB player was shown the union's lobby: Union Bank, rake treasury
 * and clubs wallet — a wallet no club member has any access to.
 *
 * resolveLobbyClubId() is the single rule those paths now share.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Chain used by isUnionClubId: .from().select().eq().maybeSingle()
const maybeSingleMock = vi.fn();
const eqMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ select: selectMock })) },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ select: selectMock })) },
}));

import {
  resolveLobbyClubId,
  resolveLobbyClubIdSync,
  isUnionClubId,
  isConfirmedUnionClubId,
  primeUnionFlags,
  clearUnionFlagCache,
  writeCachedQuickLinkClubs,
} from '../../src/utils/clubQuickLink';
import { STORAGE_KEYS } from '../../src/lib/storage';

/** Production shapes, synthetic ids. */
const MIDWAY_UNION = {
  id: 'ffffffff-0000-0000-0000-000000000001',
  name: 'Midway Union',
  club_id: 90001,
  is_union: true,
};
const SHARK_CLUB = {
  id: 'aaaaaaaa-0000-0000-0000-000000000002',
  name: 'SHARK CLUB',
  club_id: 90002,
  is_union: false,
};
const CLUB_JAQK = {
  id: 'bbbbbbbb-0000-0000-0000-000000000003',
  name: 'Club JAQK',
  club_id: 90003,
  is_union: false,
};
const VIEWER_ID = 'cccccccc-0000-0000-0000-000000000004';

beforeEach(() => {
  localStorage.clear();
  clearUnionFlagCache();
  maybeSingleMock.mockReset();
  eqMock.mockClear();
  selectMock.mockClear();
  maybeSingleMock.mockResolvedValue({ data: null, error: null });
  primeUnionFlags([MIDWAY_UNION, SHARK_CLUB, CLUB_JAQK]);
});

describe('isUnionClubId', () => {
  it('flags the union hub club', async () => {
    await expect(isUnionClubId(MIDWAY_UNION.id)).resolves.toBe(true);
  });

  it('clears ordinary clubs', async () => {
    await expect(isUnionClubId(SHARK_CLUB.id)).resolves.toBe(false);
  });

  it('reads clubs.is_union when the id is not already known', async () => {
    clearUnionFlagCache();
    maybeSingleMock.mockResolvedValueOnce({ data: { is_union: false }, error: null });
    await expect(isUnionClubId(SHARK_CLUB.id)).resolves.toBe(false);
    expect(selectMock).toHaveBeenCalledWith('is_union');
  });

  it('FAILS CLOSED — an unverifiable club counts as a union', async () => {
    clearUnionFlagCache();
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    await expect(isUnionClubId(SHARK_CLUB.id)).resolves.toBe(true);
  });
});

describe('resolveLobbyClubId — the reported bug', () => {
  it('sends a SHARK CLUB player at a MIDWAY UNION table back to SHARK CLUB', async () => {
    const club = await resolveLobbyClubId({
      viewerClubId: SHARK_CLUB.id, // the club they entered through
      tableClubId: MIDWAY_UNION.id, // the union hub the table hangs off
    });
    expect(club).toBe(SHARK_CLUB.id);
    expect(club).not.toBe(MIDWAY_UNION.id);
  });

  it('sends a Club JAQK player at a MIDWAY UNION table back to Club JAQK', async () => {
    const club = await resolveLobbyClubId({
      viewerClubId: CLUB_JAQK.id,
      tableClubId: MIDWAY_UNION.id,
    });
    expect(club).toBe(CLUB_JAQK.id);
  });

  it('never returns the union even when it is the ONLY id on offer', async () => {
    const club = await resolveLobbyClubId({
      viewerClubId: MIDWAY_UNION.id,
      tableClubId: MIDWAY_UNION.id,
    });
    // null → the caller renders HomePage. A home carousel is a fine landing
    // spot; the union's treasury is not.
    expect(club).toBeNull();
  });

  it('falls back to the last visited club when nothing better survives', async () => {
    localStorage.setItem(STORAGE_KEYS.LAST_CLUB, SHARK_CLUB.id);
    const club = await resolveLobbyClubId({
      viewerClubId: MIDWAY_UNION.id,
      tableClubId: MIDWAY_UNION.id,
    });
    expect(club).toBe(SHARK_CLUB.id);
  });

  it('falls back to the cached club list, unions filtered out', async () => {
    writeCachedQuickLinkClubs(VIEWER_ID, [MIDWAY_UNION, CLUB_JAQK, SHARK_CLUB]);
    const club = await resolveLobbyClubId({
      userId: VIEWER_ID,
      viewerClubId: null,
      tableClubId: MIDWAY_UNION.id,
    });
    expect(club).toBe(CLUB_JAQK.id);
  });
});

describe('resolveLobbyClubId — ordinary club games are unaffected', () => {
  it("keeps the table's own club when it is not a union", async () => {
    const club = await resolveLobbyClubId({ viewerClubId: null, tableClubId: SHARK_CLUB.id });
    expect(club).toBe(SHARK_CLUB.id);
  });

  it('prefers the club the player entered through over the table owner', async () => {
    // A union game HOSTED by Shark that a JAQK player joined: their chips and
    // rake belong to JAQK, so JAQK is the lobby they belong in.
    const club = await resolveLobbyClubId({
      viewerClubId: CLUB_JAQK.id,
      tableClubId: SHARK_CLUB.id,
    });
    expect(club).toBe(CLUB_JAQK.id);
  });

  it('returns null rather than guessing when there is nothing at all', async () => {
    await expect(resolveLobbyClubId({ viewerClubId: null, tableClubId: null })).resolves.toBeNull();
  });

  it('ignores non-UUID candidates (a 6-digit club code is not a club UUID)', async () => {
    const club = await resolveLobbyClubId({ viewerClubId: '90002', tableClubId: SHARK_CLUB.id });
    expect(club).toBe(SHARK_CLUB.id);
  });
});

/**
 * The two functions answer the SAME question for opposite jobs, and the split
 * is the whole safety argument. Picking a destination must fail closed; kicking
 * a player off a page must fail open. One boolean could not do both.
 */
describe('isConfirmedUnionClubId — the fail-OPEN twin', () => {
  it('agrees with isUnionClubId on a known union', async () => {
    await expect(isConfirmedUnionClubId(MIDWAY_UNION.id)).resolves.toBe(true);
    await expect(isUnionClubId(MIDWAY_UNION.id)).resolves.toBe(true);
  });

  it('agrees on a known ordinary club', async () => {
    await expect(isConfirmedUnionClubId(SHARK_CLUB.id)).resolves.toBe(false);
    await expect(isUnionClubId(SHARK_CLUB.id)).resolves.toBe(false);
  });

  it('DISAGREES on an unverifiable club, which is the point', async () => {
    clearUnionFlagCache();
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'network' } });
    // Destination picking skips it...
    await expect(isUnionClubId(SHARK_CLUB.id)).resolves.toBe(true);
    // ...but UnionSkinGuard must NOT eject a player over a network blip.
    await expect(isConfirmedUnionClubId(SHARK_CLUB.id)).resolves.toBe(false);
  });
});

/**
 * TablePage.exitDestination() runs on a Leave click and cannot await. The sync
 * pass exists so a player standing up seconds after the table loads still lands
 * in their club rather than at '/'.
 */
describe('resolveLobbyClubIdSync — answers from memory, never guesses', () => {
  it('returns the club the player entered through', () => {
    expect(
      resolveLobbyClubIdSync({ viewerClubId: SHARK_CLUB.id, tableClubId: MIDWAY_UNION.id })
    ).toBe(SHARK_CLUB.id);
  });

  it('never returns a known union', () => {
    expect(
      resolveLobbyClubIdSync({ viewerClubId: MIDWAY_UNION.id, tableClubId: MIDWAY_UNION.id })
    ).toBeNull();
  });

  it('returns null for a club whose union flag is not known yet', () => {
    clearUnionFlagCache();
    const unknown = 'dddddddd-0000-0000-0000-00000000000f';
    expect(resolveLobbyClubIdSync({ viewerClubId: unknown, tableClubId: null })).toBeNull();
  });

  it('reads flags straight off the cached club list, no network', () => {
    clearUnionFlagCache();
    localStorage.setItem(
      STORAGE_KEYS.CLUBS_CACHE,
      JSON.stringify([MIDWAY_UNION, SHARK_CLUB, CLUB_JAQK])
    );
    expect(
      resolveLobbyClubIdSync({ viewerClubId: MIDWAY_UNION.id, tableClubId: CLUB_JAQK.id })
    ).toBe(CLUB_JAQK.id);
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });

  it('agrees with the async resolver whenever it commits to an answer', async () => {
    const args = { viewerClubId: CLUB_JAQK.id, tableClubId: MIDWAY_UNION.id };
    expect(resolveLobbyClubIdSync(args)).toBe(await resolveLobbyClubId(args));
  });
});
