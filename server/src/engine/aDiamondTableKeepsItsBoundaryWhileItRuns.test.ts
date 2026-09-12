/**
 * A DIAMOND TABLE KEEPS ITS BOUNDARY WHILE IT RUNS (Phase 7 line seven).
 *
 * `refreshRakeConfig` re-reads the table row roughly once a minute and applies
 * it. That is right for a chip club - the rules follow the row - and for an
 * arena table it was a hole, because admission was the only OTHER place the
 * Diamond boundary was checked. A column flipped after the last player sat down
 * was honoured whatever it said.
 *
 * The answer is not to freeze an arena table. A staff door may legitimately
 * turn straddles or run it twice on for a table that is already running, and
 * both are inside the boundary now, so those refreshes SHOULD land and the
 * table should pick them up without a restart. What must never land is a row
 * the boundary would no longer admit.
 *
 * These are that pair: the permitted change arrives, the forbidden one does
 * not, and the forbidden one leaves the table dealing under the rules its
 * players sat down to.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const maybeSingle = vi.fn();

vi.mock('../services/supabase/client.js', () => {
  const from = () => ({
    select: () => ({ eq: () => ({ maybeSingle }) }),
  });
  return { supabase: { from }, maintenanceSupabase: { from } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');

/** An arena table exactly as the creation door opens one. */
const arenaRow = {
  game_variant: 'nlh',
  tournament_id: null,
  cluster_id: null,
  status: 'running',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  ante: 0,
  ante_enabled: false,
  rake_percent: 0,
  rake_cap_bb: 0,
  bbj_percent: 0,
  is_template: false,
  insurance_enabled: false,
  bomb_pot_enabled: false,
  run_it_twice: false,
  allow_run_it_twice: false,
  run_it_twice_enabled: false,
  straddle_enabled: false,
  auto_utg_straddle: false,
  voluntary_straddle: false,
  seven_deuce_enabled: false,
  nit_game: false,
  all_in_or_fold: false,
  pineapple_holdem: false,
  cap_enabled: false,
};

function arenaEngine(row: Record<string, unknown> = arenaRow) {
  const e = new ServerTableEngine('dddddddd-2222-4444-8888-dddddddddddd') as any;
  e.tableInfo = {
    id: e.tableId,
    club_id: 'arena',
    game_type: 'cash',
    arena: { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null },
    ...row,
  };
  e.lastRakeRefreshAtMs = 0;
  return e;
}

beforeEach(() => {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValue({ data: null });
});
afterEach(() => vi.restoreAllMocks());

describe('a permitted change lands without a restart', () => {
  it.each([
    ['straddles', { straddle_enabled: true, voluntary_straddle: true }, 'straddle_enabled'],
    [
      'a mandatory UTG straddle',
      { straddle_enabled: true, auto_utg_straddle: true },
      'auto_utg_straddle',
    ],
    ['run it twice', { run_it_twice: true, allow_run_it_twice: true }, 'run_it_twice'],
  ])('%s', async (_name, change, column) => {
    const e = arenaEngine();
    expect(e.tableInfo[column]).toBe(false);
    maybeSingle.mockResolvedValueOnce({ data: { ...arenaRow, ...change } });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo[column], `${column} did not follow the row`).toBe(true);
  });
});

describe('a change the boundary would refuse never lands', () => {
  it.each([
    ['rake', { rake_percent: 5 }, 'rake_percent', 0],
    ['a rake cap', { rake_cap_bb: 3 }, 'rake_cap_bb', 0],
    ['insurance', { insurance_enabled: true }, 'insurance_enabled', false],
    ['a bomb pot', { bomb_pot_enabled: true }, 'bomb_pot_enabled', false],
    ['the seven-deuce side bet', { seven_deuce_enabled: true }, 'seven_deuce_enabled', false],
    ['a nit game', { nit_game: true }, 'nit_game', false],
    ['an unset run-it column', { run_it_twice: null }, 'run_it_twice', false],
  ])('%s', async (_name, change, column, keeps) => {
    const e = arenaEngine();
    maybeSingle.mockResolvedValueOnce({ data: { ...arenaRow, ...change } });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo[column], `${column} was applied from a refused row`).toBe(keeps);
  });

  it('leaves every other rule on the refused row untouched too', async () => {
    /* The refusal is whole. A row that turns rake on AND straddles on is one
       row the boundary refuses, so the straddle does not arrive either - the
       table keeps exactly the rules its players sat down to. */
    const e = arenaEngine();
    maybeSingle.mockResolvedValueOnce({
      data: { ...arenaRow, rake_percent: 5, straddle_enabled: true },
    });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo.rake_percent).toBe(0);
    expect(e.tableInfo.straddle_enabled).toBe(false);
  });
});

describe('a chip table is untouched by any of this', () => {
  it('applies a rake change the way it always did', async () => {
    const e = new ServerTableEngine('cccccccc-2222-4444-8888-cccccccccccc') as any;
    e.tableInfo = {
      id: e.tableId,
      club_id: 'club',
      game_type: 'cash',
      arena: { id: 'club', asset: 'chips', is_platform: false },
      ...arenaRow,
    };
    e.lastRakeRefreshAtMs = 0;
    maybeSingle.mockResolvedValueOnce({ data: { ...arenaRow, rake_percent: 5, rake_cap_bb: 3 } });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo.rake_percent).toBe(5);
    expect(e.tableInfo.rake_cap_bb).toBe(3);
  });
});
