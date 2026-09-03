/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIMIT IS IN THE GAME VARIATIONS FILTER — and the chips cannot lie again
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31, screenshot of the Heads Up tab attached:
 *   "LIMIT POKER NEEDS TO BE ADDED TO THE GAME VARIATIONS FILTER."
 *
 * The Games row on that tab listed NLH, PLO 4c, PLO 5c, PLO 6c and 6+. Adding a
 * Limit chip on its own would have been a bug, not a fix: advancedFilterSpec
 * records three separate times that a chip whose key nothing can produce EMPTIES
 * THE TAB when it is ticked (the original FLH chip and an "OMAHA High" chip were
 * both deleted for exactly that). So limit first became a game a tournament can
 * BE, and every tournament tab's chips are now DERIVED from that one list.
 *
 * These tests pin both halves — the user-visible ask, and the invariant that
 * makes it honest. The invariant is the valuable one: it fails for a variant
 * added to the catalogue with no chip, and for a chip with no variant, in either
 * direction, forever.
 */

import { describe, it, expect } from 'vitest';
import {
  FILTER_SPECS,
  rowPassesFilter,
  emptyFilterValue,
} from '../../src/components/lobby/advancedFilterSpec';
import {
  TOURNAMENT_VARIANT_KEYS,
  SPIN_VARIANT_KEYS,
  canRunAsTournament,
  canRunAsSpin,
} from '../../src/config/tournamentVariants';
import { variantDisplay } from '../../src/components/lobby/lobbyEntries';

const keys = (tab: keyof typeof FILTER_SPECS) => (FILTER_SPECS[tab].games ?? []).map((g) => g.key);

describe("Dan's ask: limit is offered as a game variation", () => {
  it('offers FLH and FLO8 on the Heads Up tab in the screenshot', () => {
    expect(keys('SNG')).toContain('flh');
    expect(keys('SNG')).toContain('flo8');
  });

  it('offers them on the MTT tab too, because an MTT can be one', () => {
    expect(keys('MTT')).toContain('flh');
    expect(keys('MTT')).toContain('flo8');
  });

  it('keeps them on the Limit tab, where the cash games already lived', () => {
    expect(keys('LIMIT')).toEqual(['flh', 'flo8']);
  });

  it('labels them as the games they are, not as a raw enum', () => {
    expect(variantDisplay('FLH').long).toBe("Fixed Limit Hold'em");
    expect(variantDisplay('FLO8').long).toBe('Fixed Limit Omaha Hi-Lo');
    // The lower-case cash spelling has always worked; the tournament enum is
    // what was missing from TOURNEY_VARIANT_KEYS.
    expect(variantDisplay('flh').short).toBe('FLH');
  });

  it('actually narrows: ticking FLH on Heads Up keeps FLH and drops NLH', () => {
    const spec = FILTER_SPECS.SNG;
    const v = { ...emptyFilterValue(spec), games: ['flh'] };
    const row = (variant: string) => ({ variant, price: 10, row: {}, settings: {} });
    expect(rowPassesFilter(spec, v, row('FLH'))).toBe(true);
    expect(rowPassesFilter(spec, v, row('NLH'))).toBe(false);
  });
});

describe('the chips and the create screen cannot disagree', () => {
  /* THE FORWARD DIRECTION. A chip nothing can produce empties the tab when it
     is ticked, and the player is given no way to tell why. */
  it('every chip on the MTT and Heads Up tabs is a game a tournament can be', () => {
    for (const tab of ['MTT', 'SNG'] as const) {
      for (const key of keys(tab)) {
        // `pineapple` is the one deliberate exception and is asserted below.
        if (key === 'pineapple') continue;
        expect(canRunAsTournament(key), `${tab} chip ${key}`).toBe(true);
      }
    }
  });

  /* THE REVERSE DIRECTION, which is how the missing PLO Hi/Lo chip on Heads Up
     was found: a producible variant with no chip is deleted from the board the
     moment a player ticks any other chip. */
  it('every game a tournament can be has a chip on both tabs', () => {
    for (const key of TOURNAMENT_VARIANT_KEYS) {
      expect(keys('MTT'), `MTT is missing ${key}`).toContain(key);
      expect(keys('SNG'), `Heads Up is missing ${key}`).toContain(key);
    }
  });

  it('keeps a chip for the legacy Pineapple event that exists but cannot be made', () => {
    // One OFC_PINEAPPLE row is live. Without a chip it disappears behind any
    // other chip; with one it stays filterable. Creating a new one stays refused.
    expect(keys('MTT')).toContain('pineapple');
    expect(canRunAsTournament('pineapple')).toBe(false);
  });

  it('the Spins tab shows exactly the games Spin & Go sells', () => {
    expect(keys('SPIN')).toEqual([...SPIN_VARIANT_KEYS]);
    for (const key of keys('SPIN')) expect(canRunAsSpin(key)).toBe(true);
    // ...and the catalogue is narrower than the tournament list, which is the
    // whole reason this tab is derived from its own source.
    expect(keys('SPIN')).not.toContain('plo8');
    expect(keys('SPIN')).not.toContain('short_deck');
    expect(keys('SPIN')).not.toContain('flh');
  });

  it('gives every chip a label a player can read', () => {
    for (const tab of ['MTT', 'SNG', 'SPIN', 'LIMIT', 'HOLDEM', 'OMAHA'] as const) {
      for (const chip of FILTER_SPECS[tab].games ?? []) {
        expect(chip.label.trim().length, `${tab} ${chip.key}`).toBeGreaterThan(0);
        // A key leaking through as its own label means the label map missed it.
        expect(chip.label).not.toBe(chip.key);
      }
    }
  });
});
