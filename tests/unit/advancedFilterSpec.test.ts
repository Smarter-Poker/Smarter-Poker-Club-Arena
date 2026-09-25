/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADVANCED FILTERS — the fields must actually FILTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Written after the 2026-08-21 audit found the worst shape a filter can take.
 * The sheet collected NINE fields; the lobby applied THREE. `games`, `format`
 * and `statuses` were saved, re-rendered as selected chips on reopen, and then
 * ignored - so a player could pick "NLH only", press Save, and get back an
 * identical list. Nothing was broken in a way anyone could see; the control
 * simply did not do what it said.
 *
 * These tests exist so that can never be true again silently. Every field on
 * GameFilterValue gets a case proving it changes the outcome, plus the
 * "untouched means everything passes" case that stops a filter from quietly
 * emptying the lobby.
 */
import { describe, it, expect } from 'vitest';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
  isFilterActive,
  type FilterableRow,
} from '../../src/components/lobby/advancedFilterSpec';

const holdem = FILTER_SPECS.HOLDEM;
const sng = FILTER_SPECS.SNG;

const row = (over: Partial<FilterableRow> = {}): FilterableRow => ({
  variant: 'nlh',
  price: 2,
  seats: 6,
  seatsTaken: 3,
  name: 'NLH 1/2',
  row: {},
  settings: {},
  ...over,
});

describe('rowPassesFilter: an untouched filter hides nothing', () => {
  it('passes every row when nothing is selected', () => {
    for (const key of ['HOLDEM', 'OMAHA', 'LIMIT', 'MTT', 'SPIN', 'SNG'] as const) {
      const spec = FILTER_SPECS[key];
      expect(rowPassesFilter(spec, emptyFilterValue(spec), row()), key).toBe(true);
    }
  });
});

describe('games chips', () => {
  it('keeps a matching variant and drops the rest', () => {
    const v = { ...emptyFilterValue(holdem), games: ['nlh'] };
    expect(rowPassesFilter(holdem, v, row())).toBe(true);
    expect(rowPassesFilter(holdem, v, row({ variant: 'plo4' }))).toBe(false);
  });

  it('passes a variant it does not recognise rather than hiding a real table', () => {
    const v = { ...emptyFilterValue(holdem), games: ['nlh'] };
    expect(rowPassesFilter(holdem, v, row({ variant: '' }))).toBe(true);
  });
});

describe('LIMIT spec', () => {
  it('filters like the other cash tabs: untouched hides nothing, narrowed narrows', () => {
    const limit = FILTER_SPECS.LIMIT;
    const flh = row({ variant: 'flh', price: 2 });
    expect(rowPassesFilter(limit, emptyFilterValue(limit), flh)).toBe(true);
    const band = { ...emptyFilterValue(limit), rangeMin: 3, rangeMax: 8 };
    expect(rowPassesFilter(limit, band, flh)).toBe(false);
    const full = { ...emptyFilterValue(limit), statuses: ['full'] };
    expect(rowPassesFilter(limit, full, row({ variant: 'flh', seatsTaken: 6 }))).toBe(true);
    expect(rowPassesFilter(limit, full, row({ variant: 'flh', seatsTaken: 3 }))).toBe(false);
  });
});

describe('status chips', () => {
  it('distinguishes full from partly seated', () => {
    const v = { ...emptyFilterValue(holdem), statuses: ['full'] };
    expect(rowPassesFilter(holdem, v, row({ seatsTaken: 6 }))).toBe(true);
    expect(rowPassesFilter(holdem, v, row({ seatsTaken: 3 }))).toBe(false);
  });

  it('is an OR within itself, not an impossible intersection', () => {
    const v = { ...emptyFilterValue(holdem), statuses: ['empty', 'full'] };
    expect(rowPassesFilter(holdem, v, row({ seatsTaken: 0 }))).toBe(true);
    expect(rowPassesFilter(holdem, v, row({ seatsTaken: 6 }))).toBe(true);
    expect(rowPassesFilter(holdem, v, row({ seatsTaken: 3 }))).toBe(false);
  });
});

describe('seat range', () => {
  it('applies to tournament specs too, not only cash', () => {
    const v = { ...emptyFilterValue(sng), seatMin: 2, seatMax: 2 };
    expect(rowPassesFilter(sng, v, row({ seats: 2 }))).toBe(true);
    expect(rowPassesFilter(sng, v, row({ seats: 9 }))).toBe(false);
  });
});

describe('format chips', () => {
  it('separates satellites from regular games', () => {
    /* REPLACED 2026-09-22: this chip used to decide from the NAME alone, so
       both cases were bare names. The satellite columns decide now
       (isSatelliteTournament in utils/tournamentFilters); the name is the
       fallback for a row that does not carry them, and it only ever says yes,
       so a bare "Heads-Up 5" with no columns is no opinion rather than "no". */
    const v = { ...emptyFilterValue(sng), format: ['sats'] };
    const regular = {
      variant: 'sng',
      tournament_type: 'SNG',
      satellite_target_id: null,
      satellite_target: null,
    };
    expect(
      rowPassesFilter(
        sng,
        v,
        row({ name: 'NLH Heads-Up 5', row: { ...regular, satellite_target_id: 't1' } })
      )
    ).toBe(true);
    expect(rowPassesFilter(sng, v, row({ name: 'NLH Heads-Up 5', row: regular }))).toBe(false);
    expect(rowPassesFilter(sng, v, row({ name: 'NLH Sat To Main' }))).toBe(true);
    // No columns and a title that says nothing: no opinion, so not hidden.
    expect(rowPassesFilter(sng, v, row({ name: 'NLH Heads-Up 5' }))).toBe(true);
  });

  it('treats both-selected as no opinion', () => {
    const v = { ...emptyFilterValue(sng), format: ['sats', 'regular'] };
    expect(rowPassesFilter(sng, v, row({ name: 'NLH Heads-Up 5' }))).toBe(true);
    expect(rowPassesFilter(sng, v, row({ name: 'NLH Sat To Main' }))).toBe(true);
  });
});

describe('price range', () => {
  it('drops a row outside the band', () => {
    const v = { ...emptyFilterValue(holdem), rangeMin: 3, rangeMax: 8 };
    expect(rowPassesFilter(holdem, v, row({ price: 2 }))).toBe(false);
    expect(rowPassesFilter(holdem, v, row({ price: 5 }))).toBe(true);
  });
});

describe('must-have and hide', () => {
  it('requires every must-have and excludes any hidden feature', () => {
    const must = { ...emptyFilterValue(holdem), mustHave: ['bomb_pot'] };
    expect(rowPassesFilter(holdem, must, row({ settings: { bomb_pot_enabled: true } }))).toBe(true);
    /* REPLACED 2026-09-22, in the commit that made the matcher three-valued.
       This used `settings: {}` with an empty row, i.e. a row that never
       carried the column, and required MUST-HAVE to delete it. That is the
       behaviour the matcher's own contract forbade ("a filter that cannot be
       evaluated passes"). A row that SAYS it has no Bomb Pot is the real
       "no", so the case now carries the column, switched off. */
    expect(rowPassesFilter(holdem, must, row({ row: { bomb_pot_enabled: false } }))).toBe(false);

    const hide = { ...emptyFilterValue(holdem), hide: ['bomb_pot'] };
    expect(rowPassesFilter(holdem, hide, row({ settings: { bomb_pot_enabled: true } }))).toBe(
      false
    );
    expect(rowPassesFilter(holdem, hide, row({ row: { bomb_pot_enabled: false } }))).toBe(true);
  });

  it('keeps a row that cannot answer, under must-have and hide alike', () => {
    const must = { ...emptyFilterValue(holdem), mustHave: ['bomb_pot'] };
    const hide = { ...emptyFilterValue(holdem), hide: ['bomb_pot'] };
    expect(rowPassesFilter(holdem, must, row({ settings: {} }))).toBe(true);
    expect(rowPassesFilter(holdem, hide, row({ settings: {} }))).toBe(true);
  });
});

describe('isFilterActive', () => {
  it('is false until something is genuinely narrowed', () => {
    expect(isFilterActive(holdem, emptyFilterValue(holdem))).toBe(false);
  });

  it('is true for every field a player can change', () => {
    const base = emptyFilterValue(holdem);
    expect(isFilterActive(holdem, { ...base, games: ['nlh'] })).toBe(true);
    expect(isFilterActive(holdem, { ...base, statuses: ['full'] })).toBe(true);
    expect(isFilterActive(holdem, { ...base, mustHave: ['bomb_pot'] })).toBe(true);
    expect(isFilterActive(holdem, { ...base, hide: ['bomb_pot'] })).toBe(true);
    expect(isFilterActive(holdem, { ...base, rangeMin: 3 })).toBe(true);
    expect(isFilterActive(holdem, { ...base, seatMax: 6 })).toBe(true);
  });
});

describe('every board entry is coherent', () => {
  it('gives each spec at least one status and a usable range', () => {
    for (const key of ['HOLDEM', 'OMAHA', 'LIMIT', 'MTT', 'SPIN', 'SNG'] as const) {
      const s = FILTER_SPECS[key];
      expect(s.statuses.length, `${key} statuses`).toBeGreaterThan(0);
      expect(s.range.max, `${key} range`).toBeGreaterThan(s.range.min);
      expect(s.range.presets.length, `${key} presets`).toBeGreaterThan(0);
      for (const p of s.range.presets) {
        expect(p.min, `${key}/${p.key} min`).toBeGreaterThanOrEqual(s.range.min);
        expect(p.max, `${key}/${p.key} max`).toBeLessThanOrEqual(s.range.max);
      }
    }
  });

  it('has no duplicate feature keys within a spec', () => {
    for (const key of ['HOLDEM', 'OMAHA', 'LIMIT', 'MTT', 'SPIN', 'SNG'] as const) {
      const keys = FILTER_SPECS[key].features.map((f) => f.key);
      expect(new Set(keys).size, `${key} duplicate feature keys`).toBe(keys.length);
    }
  });
});
