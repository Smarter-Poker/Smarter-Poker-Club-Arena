/**
 * A LOBBY PREFERENCE IS FINISHED WHEN THE ROW HAS IT (2026-10-16)
 *
 * Four defects in the cross-device lobby preferences, each pinned here:
 *   1. A save the network dropped left the row one choice behind, and the next
 *      lobby open let that older row overwrite the newer choice on the device.
 *   2. Advanced Filters were cached per club only, so one account's filters
 *      survived sign-out and silently filtered the next account's lobby.
 *   3. The lobby's quick chips wrote only this browser's cache, and the lobby
 *      never read the row at all, so filters followed the player only while
 *      the filter sheet happened to be open.
 *   4. A request the browser abandoned (navigation) was reported as an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  writes: [] as Array<{ payload: any; resolve: (v: any) => void; reject: (e: any) => void }>,
  session: { userId: 'account-a' } as { userId: string } | null,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      upsert: (payload: unknown) =>
        new Promise((resolve, reject) => state.writes.push({ payload, resolve, reject })),
    }),
  },
}));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => state.session }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/errorReporter', () => ({ reportError }));

import {
  hasUnsyncedViewPrefs,
  isAbortedRequest,
  pushRemoteViewPrefs,
} from '../../src/components/lobby/lobbyViewPrefs';
import {
  hasUnsyncedFilters,
  loadFilters,
  persistFilters,
  pushRemoteFilters,
  saveFilters,
  stageFilters,
} from '../../src/components/lobby/AdvancedFilters';
import { FILTER_SPECS, emptyFilterValue } from '../../src/components/lobby/advancedFilterSpec';

const GAME_A = FILTER_SPECS.HOLDEM.games![0].key;
const GAME_B = FILTER_SPECS.HOLDEM.games![1].key;

const plo = { tab: 'OMAHA' as const, sortByTab: {}, favoritesOnly: false };
const holdem = { ...plo, tab: 'HOLDEM' as const };
const settle = () => new Promise((r) => setTimeout(r, 0));
// The write queues are module-level per account+club, so every test gets a
// club of its own and an unresolved request in one cannot hold up the next.
let clubSeq = 0;
let club = 'club-0';

beforeEach(() => {
  localStorage.clear();
  state.writes.length = 0;
  state.session = { userId: 'account-a' };
  reportError.mockClear();
  clubSeq += 1;
  club = `club-${clubSeq}`;
});

describe('an unconfirmed tab/sort choice is never overwritten by the older row', () => {
  it('stays unsynced after a failed save and is cleared by the next confirmed save', async () => {
    pushRemoteViewPrefs(club, plo, 'account-a');
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(true);
    state.writes[0].resolve({ error: { message: 'network down' } });
    await settle();
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(true);

    pushRemoteViewPrefs(club, plo, 'account-a');
    state.writes[1].resolve({ error: null });
    await settle();
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(false);
  });

  it('only the newest queued choice can declare the device synced', async () => {
    pushRemoteViewPrefs(club, holdem, 'account-a');
    pushRemoteViewPrefs(club, plo, 'account-a');
    state.writes[0].resolve({ error: null });
    await settle();
    // The PLO tap has not reached the row yet.
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(true);
    state.writes[1].resolve({ error: null });
    await settle();
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(false);
  });

  it('is kept per account', () => {
    pushRemoteViewPrefs(club, plo, 'account-a');
    expect(hasUnsyncedViewPrefs(club, 'account-b')).toBe(false);
  });

  it('the lobby finishes the unconfirmed write instead of applying the row', () => {
    const page = readFileSync(join(__dirname, '..', '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    const hydrate = page.slice(
      page.indexOf('if (hasUnsyncedViewPrefs(resolvedClubId'),
      page.indexOf('void fetchRemoteViewPrefs(resolvedClubId')
    );
    expect(hydrate).toMatch(
      /pushRemoteViewPrefs\(resolvedClubId, saved, currentUser\?\.id\);\s*return;/
    );
  });
});

describe('a navigation abort is the player leaving, not a failed save', () => {
  it('recognises the shapes the browser and PostgREST client produce', () => {
    expect(isAbortedRequest({ name: 'AbortError' })).toBe(true);
    expect(isAbortedRequest({ message: 'AbortError: The operation was aborted.' })).toBe(true);
    expect(isAbortedRequest({ message: 'permission denied' })).toBe(false);
    expect(isAbortedRequest(null)).toBe(false);
  });

  it('does not report an aborted save, and keeps it owed to the row', async () => {
    pushRemoteViewPrefs(club, plo, 'account-a');
    state.writes[0].resolve({ error: { message: 'AbortError: The operation was aborted.' } });
    await settle();
    expect(reportError).not.toHaveBeenCalled();
    expect(hasUnsyncedViewPrefs(club, 'account-a')).toBe(true);
  });

  it('still reports a real failure', async () => {
    pushRemoteViewPrefs(club, plo, 'account-a');
    state.writes[0].resolve({ error: { message: 'permission denied' } });
    await settle();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe('Advanced Filters belong to one account', () => {
  const bomb = { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: [GAME_A] } };

  it('keeps each account its own filters on a shared browser', () => {
    saveFilters(club, bomb, 'account-a');
    expect(loadFilters(club, 'account-a').HOLDEM?.games).toEqual([GAME_A]);
    expect(loadFilters(club, 'account-b')).toEqual({});
  });

  it('adopts a pre-account browser store for exactly one account', () => {
    localStorage.setItem(`ca_advanced_filters_${club}`, JSON.stringify(bomb));
    expect(loadFilters(club, 'account-a').HOLDEM?.games).toEqual([GAME_A]);
    expect(loadFilters(club, 'account-b')).toEqual({});
  });

  it('signed out still reads and writes the per-club key', () => {
    saveFilters(club, bomb, null);
    expect(localStorage.getItem(`ca_advanced_filters_${club}`)).toContain(GAME_A);
    expect(loadFilters(club, null).HOLDEM?.games).toEqual([GAME_A]);
  });
});

describe('every lobby filter change reaches the row, in order', () => {
  const a = { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: [GAME_A] } };
  const b = { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: [GAME_B] } };

  it('persistFilters writes the cache and the row', async () => {
    persistFilters(club, a);
    expect(loadFilters(club, 'account-a').HOLDEM?.games).toEqual([GAME_A]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].payload.filters.HOLDEM.games).toEqual([GAME_A]);
    expect(hasUnsyncedFilters(club, 'account-a')).toBe(true);
    state.writes[0].resolve({ error: null });
    await settle();
    expect(hasUnsyncedFilters(club, 'account-a')).toBe(false);
  });

  it('a slow earlier save never lands after the last tap', async () => {
    pushRemoteFilters(club, a);
    pushRemoteFilters(club, b);
    expect(state.writes).toHaveLength(1);
    state.writes[0].resolve({ error: null });
    await vi.waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1].payload.filters.HOLDEM.games).toEqual([GAME_B]);
    expect(hasUnsyncedFilters(club, 'account-a')).toBe(true);
    state.writes[1].resolve({ error: null });
    await settle();
    expect(hasUnsyncedFilters(club, 'account-a')).toBe(false);
  });

  it('the lobby writes no filter change to the cache alone, and reads the row on open', () => {
    const page = readFileSync(join(__dirname, '..', '..', 'src/pages/ClubHomePage.tsx'), 'utf8');
    expect(page).not.toMatch(/if \(resolvedClubId\) saveFilters\(resolvedClubId, next\)/);
    expect(
      page.match(/persistAdvFilters\(resolvedClubId, next\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(5);
    const hydrate = page.slice(
      page.indexOf('const cached = loadFilters(resolvedClubId'),
      page.indexOf(
        '}, [resolvedClubId, currentUser?.id]);',
        page.indexOf('const cached = loadFilters(resolvedClubId')
      )
    );
    expect(hydrate).toMatch(/hasUnsyncedFilters\(resolvedClubId/);
    expect(hydrate).toMatch(/pushRemoteFilters\(resolvedClubId, cached\)/);
    expect(hydrate).toMatch(/void fetchRemoteFilters\(resolvedClubId\)/);
    expect(hydrate).toMatch(/advFiltersTouched\.current/);
  });
});

it('a newly staged slider choice remains pending when an older save finishes during debounce', async () => {
  const first = { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: [GAME_A] } };
  const newer = { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: [GAME_B] } };
  persistFilters(club, first);
  stageFilters(club, newer, 'account-a');
  state.writes[0].resolve({ error: null });
  await settle();
  expect(hasUnsyncedFilters(club, 'account-a')).toBe(true);
  expect(loadFilters(club, 'account-a').HOLDEM?.games).toEqual([GAME_B]);
  pushRemoteFilters(club, newer);
  state.writes[1].resolve({ error: null });
  await settle();
  expect(hasUnsyncedFilters(club, 'account-a')).toBe(false);
});
