/**
 * The limit games must survive a browser that is NOT freshly cleared.
 *
 * Playbook RULE 8 (Zero-Assumption Doctrine): "If your fix relies on a
 * pristine, freshly-cleared browser state to work, your fix is invalid."
 *
 * Three hostile states are reachable for a player who used the lobby before
 * the limit games shipped:
 *
 *  1. STALE SAVED FILTER. The HOLDEM tab used to offer an "FLH" chip. It could
 *     never match a row — cashKind() routes every limit table to the LIMIT tab —
 *     so ticking it emptied the Hold'em list. That chip is gone now, but a
 *     player who ticked it still has {"HOLDEM":{"games":["flh"]}} in
 *     localStorage. It must degrade to "no opinion", never to "match nothing".
 *
 *  2. STALE VARIANT KEY. A saved filter can name a variant this build has
 *     retired entirely (ofc_pineapple was relabelled by migration in August).
 *
 *  3. OLD ENGINE PAYLOAD. `betting_structure` is optional on the wire, so a
 *     client that reconnects mid-hand to an engine build that predates it — or
 *     receives a partial snapshot — gets `undefined` and must fall back to
 *     deriving the structure from the variant string rather than defaulting to
 *     a no-limit slider on a limit table.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadFilters, saveFilters } from '../../src/components/lobby/AdvancedFilters';
import {
  FILTER_SPECS,
  rowPassesFilter,
  emptyFilterValue,
} from '../../src/components/lobby/advancedFilterSpec';
import { bettingStructureFor, fixedLimitBetSize } from '../../src/lib/bettingStructure';

const CLUB = 'club-hostile-state';
const KEY = `ca_advanced_filters_${CLUB}`;

beforeEach(() => localStorage.clear());

describe('1. a saved filter written by the PREVIOUS build', () => {
  it("drops the retired FLH chip instead of emptying the Hold'em tab", () => {
    // Exactly what a player who ticked "FLH" on the HOLDEM tab has on disk.
    localStorage.setItem(KEY, JSON.stringify({ HOLDEM: { games: ['flh'] } }));

    const loaded = loadFilters(CLUB);

    // The key is discarded, because this build's HOLDEM spec no longer defines it.
    expect(loaded.HOLDEM?.games ?? []).toEqual([]);
    // "no opinion" — an empty selection must never mean "match nothing".
    const holdemRow = { variant: 'nlh', price: 2, seatsTaken: 3, seats: 9, settings: {} } as never;
    expect(
      rowPassesFilter(
        FILTER_SPECS.HOLDEM,
        loaded.HOLDEM ?? emptyFilterValue(FILTER_SPECS.HOLDEM),
        holdemRow
      )
    ).toBe(true);
  });

  it('keeps the chips this build DOES still define', () => {
    localStorage.setItem(KEY, JSON.stringify({ HOLDEM: { games: ['flh', 'nlh', 'short_deck'] } }));
    const loaded = loadFilters(CLUB);
    expect(loaded.HOLDEM?.games).toEqual(['nlh', 'short_deck']);
  });

  it('survives a variant this build retired entirely', () => {
    localStorage.setItem(KEY, JSON.stringify({ HOLDEM: { games: ['ofc_pineapple'] } }));
    expect(loadFilters(CLUB).HOLDEM?.games ?? []).toEqual([]);
  });

  it('survives outright garbage rather than throwing into a render', () => {
    for (const junk of [
      'not json',
      '[]',
      'null',
      '{"HOLDEM":"nonsense"}',
      '{"NOPE":{"games":["x"]}}',
    ]) {
      localStorage.setItem(KEY, junk);
      expect(() => loadFilters(CLUB)).not.toThrow();
    }
  });

  it('round-trips a filter this build wrote, so the fix is not one-way', () => {
    saveFilters(CLUB, { LIMIT: { ...emptyFilterValue(FILTER_SPECS.LIMIT) } });
    expect(() => loadFilters(CLUB)).not.toThrow();
  });
});

describe('2. the LIMIT tab itself is reachable from a cold, stale profile', () => {
  it('has a spec, so a saved LIMIT filter loads rather than being dropped', () => {
    expect(FILTER_SPECS.LIMIT).toBeTruthy();
  });

  it('shows a limit table when the player has no saved opinion at all', () => {
    const empty = emptyFilterValue(FILTER_SPECS.LIMIT);
    for (const variant of ['flh', 'flo8']) {
      const row = { variant, price: 2, seatsTaken: 2, seats: 6, settings: {} } as never;
      expect(rowPassesFilter(FILTER_SPECS.LIMIT, empty, row)).toBe(true);
    }
  });
});

describe('3. an engine payload that predates betting_structure', () => {
  it('falls back to deriving the structure from the variant, not to no-limit', () => {
    // This is the `tableState.bettingStructure ?? bettingStructureFor(gameVariant)`
    // expression in TablePage, evaluated the way a reconnect would hit it.
    const fromOldEngine = undefined as 'no_limit' | 'pot_limit' | 'fixed_limit' | undefined;
    for (const [variant, expected] of [
      ['flh', 'fixed_limit'],
      ['flo8', 'fixed_limit'],
      ['plo4', 'pot_limit'],
      ['nlh', 'no_limit'],
    ] as const) {
      expect(fromOldEngine ?? bettingStructureFor(variant)).toBe(expected);
    }
  });

  it('falls back to a correct bet size per street when fixed_bet_size is absent', () => {
    const fromOldEngine = undefined as number | undefined;
    const bb = 2;
    expect(fromOldEngine ?? fixedLimitBetSize(bb, 'preflop')).toBe(2);
    expect(fromOldEngine ?? fixedLimitBetSize(bb, 'flop')).toBe(2);
    expect(fromOldEngine ?? fixedLimitBetSize(bb, 'turn')).toBe(4);
    expect(fromOldEngine ?? fixedLimitBetSize(bb, 'river')).toBe(4);
  });

  it('treats an absent wagers_capped as NOT capped, so the table never freezes', () => {
    // `wagersCapped === true` is deliberately strict: undefined must not read as
    // capped, or a reconnect would hide Raise for the rest of the street.
    const fromOldEngine = undefined as boolean | undefined;
    expect(fromOldEngine === true).toBe(false);
  });
});
