/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE WIRING AROUND THE SAVED VIEW, NOT THE MODULE ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `lobbyViewPrefs` is keyed per club and its own tests prove one club's saved
 * view can never be read as another's. That guarantee is only as good as the
 * code calling it, and the first version of the calling code broke it.
 *
 * THE BUG. Persistence runs from an effect keyed on `[resolvedClubId,
 * viewPrefs]`. Those two update on DIFFERENT TICKS. Moving from club A to club
 * B runs that effect in the same commit as hydration, at a moment when
 * `resolvedClubId` is already B but `viewPrefs` still holds A's values --
 * `setViewPrefs` has not landed. The write then puts club A's tab, sort and
 * Favorites into club B's storage key. Per-club keying, defeated one layer up.
 *
 * These are source-level assertions because the failure is an EFFECT ORDERING
 * race: a render test has to lose the race deliberately to see it, and would
 * pass against the broken code on a fast machine. Same reasoning as
 * addTableResolvesClubOnDemand.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../src/pages/ClubHomePage.tsx'), 'utf8');

/** The persistence effect: the one place that writes the saved view. */
const WRITER = SRC.slice(
  SRC.indexOf('One writer, watching the value'),
  SRC.indexOf('/** Pick a tab:')
);

/** The hydration effect: the one place that reads it. */
const HYDRATOR = SRC.slice(
  SRC.indexOf('The same rule for the tab / sort / Favorites triple'),
  SRC.indexOf('One writer, watching the value')
);

describe('the saved view cannot leak between clubs', () => {
  it('the writer proves the prefs it holds belong to the club it writes to', () => {
    expect(WRITER).toMatch(/viewPrefsOwner\.current !== resolvedClubId/);
    expect(WRITER).toMatch(/saveViewPrefs\(resolvedClubId, viewPrefs\)/);
  });

  it('the writer refuses to echo a hydration back into storage', () => {
    expect(WRITER).toMatch(/!viewPrefsTouched\.current/);
  });

  it('a club switch clears the "player already chose" flag', () => {
    // Without this, a choice made in club A suppresses club B's saved view AND
    // leaves A's values in state looking like B's.
    expect(HYDRATOR).toMatch(/switchingClubs/);
    expect(HYDRATOR).toMatch(/if \(switchingClubs\) viewPrefsTouched\.current = false/);
  });

  it('a FIRST load keeps the flag, so a tab tapped before resolution still wins', () => {
    // switchingClubs is only true when a previous club existed.
    expect(HYDRATOR).toMatch(/const switchingClubs = viewPrefsOwner\.current !== null/);
  });

  it('hydration claims ownership before anything can write', () => {
    const claimAt = HYDRATOR.indexOf('viewPrefsOwner.current = resolvedClubId');
    const loadAt = HYDRATOR.indexOf('loadViewPrefs(resolvedClubId)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(claimAt);
  });
});

describe('the state updater stays pure', () => {
  it('no storage write happens inside setViewPrefs', () => {
    /* React may invoke a state updater more than once (it does exactly that
       under StrictMode). A write in there is a side effect in a place that
       does not promise to run once. */
    const UPDATER = SRC.slice(
      SRC.indexOf('const updateViewPrefs = useCallback('),
      SRC.indexOf('One writer, watching the value')
    );
    const setter = UPDATER.slice(UPDATER.indexOf('setViewPrefs((prev)'));
    expect(setter).not.toMatch(/saveViewPrefs/);
  });
});

describe('every control that changes the view goes through the one door', () => {
  it('the tab buttons, the sort control and the Favorites chip all persist', () => {
    // A control wired straight to its setState would change the screen and
    // silently forget -- which is how the page-level sort went unsaved while
    // LobbyTable's column sort was saved all along.
    expect(SRC).toMatch(/selectGameType\(tab\.key\)/);
    expect(SRC).toMatch(/onSortChange=\{selectSortKey\}/);
    expect(SRC).toMatch(/selectFavoritesOnly\(!favoritesOnly\)/);
    // Clearing is a choice too, so it persists like the rest.
    expect(SRC).toMatch(/selectFavoritesOnly\(false\);\s*\n\s*selectGameType\('ALL'\)/);
  });
});
