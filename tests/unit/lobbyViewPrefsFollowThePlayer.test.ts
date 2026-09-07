/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LOBBY VIEW FOLLOWS THE PLAYER, NOT THE BROWSER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 5: "FILTER TAB SELECTIONS NEED TO BE SAVED AND CACHED
 * AS WELL AS SAVED AND UPDATED ON CROSS USER DEVICES. THEY SHOULD BE SAVED
 * REGARDLESS OF WHICH DEVICE YOU LOG INTO."
 *
 * The lobby had this for the Advanced Filters sheet (user_lobby_filters,
 * 2026-08-31) and not for the game-type tab, the sort, or the Favorites chip —
 * which are the three a player notices first, because they change what the
 * board looks like at a glance.
 *
 * These pin the two halves that make it work: the DATABASE is the truth, and
 * localStorage is the synchronous first-paint cache. The interesting cases are
 * all about what the remote read must REFUSE to do, because every one of them
 * would be a worse bug than the stale tab being fixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

const maybeSingle = vi.fn();
const upsert = vi.fn(() => ({ then: (f: (r: { error: null }) => void) => f({ error: null }) }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
      upsert,
    }),
  },
}));
vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () => ({ userId: 'u-1' }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const CLUB = 'club-1';

describe('the saved view is read back from the database', () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    upsert.mockClear();
  });
  afterEach(() => vi.resetModules());

  it('returns the row a different device wrote', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        view_prefs: { tab: 'OMAHA', sortByTab: { OMAHA: 'stakes_high' }, favoritesOnly: true },
      },
      error: null,
    });
    const { fetchRemoteViewPrefs } = await import('../../src/components/lobby/lobbyViewPrefs');
    expect(await fetchRemoteViewPrefs(CLUB)).toEqual({
      tab: 'OMAHA',
      sortByTab: { OMAHA: 'stakes_high' },
      favoritesOnly: true,
    });
  });

  it('validates the ROW through the same door as localStorage', async () => {
    /* A row is exactly as untrustworthy as a local blob: it can be written by
       an older build, or by a newer one on another device. An unvalidated
       remote value would select a tab this build cannot render — the failure
       the local read was already hardened against, reintroduced over the
       network. */
    maybeSingle.mockResolvedValue({
      data: {
        view_prefs: {
          tab: 'RAZZ_NIGHT',
          sortByTab: { OMAHA: 'by_vibes', MTT: 'players' },
          favoritesOnly: 'yes',
        },
      },
      error: null,
    });
    const { fetchRemoteViewPrefs } = await import('../../src/components/lobby/lobbyViewPrefs');
    expect(await fetchRemoteViewPrefs(CLUB)).toEqual({
      tab: null, // unknown tab dropped, not selected
      sortByTab: { MTT: 'players' }, // unknown sort dropped, valid one kept
      favoritesOnly: false, // a truthy string is not `true`
    });
  });

  it('a failed read is indistinguishable from no row, and both mean "keep the cache"', async () => {
    /* Null on purpose. If a network failure returned defaults instead, a
       player with a bad connection would watch their own saved tab reset —
       which reads as "it forgot again", the exact complaint. */
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'nope' } });
    const { fetchRemoteViewPrefs } = await import('../../src/components/lobby/lobbyViewPrefs');
    expect(await fetchRemoteViewPrefs(CLUB)).toBeNull();

    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await fetchRemoteViewPrefs(CLUB)).toBeNull();
  });
});

describe('the write shares its row without clobbering the filters beside it', () => {
  beforeEach(() => upsert.mockClear());
  afterEach(() => vi.resetModules());

  it('upserts only view_prefs, on the user+club conflict target', async () => {
    const { pushRemoteViewPrefs } = await import('../../src/components/lobby/lobbyViewPrefs');
    pushRemoteViewPrefs(CLUB, { tab: 'MTT', sortByTab: {}, favoritesOnly: false });
    const [payload, opts] = upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { onConflict: string },
    ];
    expect(payload.view_prefs).toEqual({ tab: 'MTT', sortByTab: {}, favoritesOnly: false });
    // The Advanced Filters sheet owns `filters` on this same row and writes it
    // independently. Naming it here would blank whatever it last saved.
    expect(payload).not.toHaveProperty('filters');
    expect(opts.onConflict).toBe('user_id,club_id');
  });
});

describe('the page wires both halves in the right order', () => {
  const PAGE = read('src/pages/ClubHomePage.tsx');

  it('paints from the cache first, then lets the row correct it', () => {
    const local = PAGE.indexOf('const saved = loadViewPrefs(resolvedClubId)');
    const remote = PAGE.indexOf('fetchRemoteViewPrefs(resolvedClubId)');
    expect(local).toBeGreaterThan(-1);
    expect(remote).toBeGreaterThan(local);
  });

  /* Windows bounded by STRUCTURE, never by a byte count
     (tests/helpers/sourceWindow, and the law that reads it): a fixed-size
     window drifts off the code it guards the moment someone adds a comment —
     silently, in the direction that still passes. */
  it('the correction refuses a stale club, a mid-flight choice, and a null', () => {
    // The hydration effect's own body, which encloses both the call and the
    // callback whose guards are the point of this test.
    const block = sliceEnclosingBlock(PAGE, 'void fetchRemoteViewPrefs(resolvedClubId)');
    expect(block).toContain('if (cancelled || !remote) return;');
    expect(block).toContain('if (viewPrefsOwner.current !== resolvedClubId) return;');
    expect(block).toContain('if (viewPrefsTouched.current) return;');
  });

  it('every settled change is written to BOTH the cache and the row', () => {
    const effect = sliceEnclosingBlock(PAGE, 'saveViewPrefs(resolvedClubId, viewPrefs);');
    expect(effect).toContain('pushRemoteViewPrefs(resolvedClubId, viewPrefs);');
  });
});
