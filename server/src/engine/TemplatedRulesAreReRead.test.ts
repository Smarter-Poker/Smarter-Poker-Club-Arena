/**
 * THE TEMPLATED RULES FOLLOW THE ROW (2026-09-09, lane E of the must-move audit)
 *
 * A cluster table's rules are rewritten by `fn_cash_apply_ruleset` on every
 * tick, from the template the players chose the game by. The engine held them
 * as a boot-time snapshot: `this.tableInfo` has three writers, and only
 * `refreshRakeConfig` runs on a live cash table, and it read rake plus the
 * bomb columns and nothing else.
 *
 * So on 2026-09-09, when the realignment turned the ante off on 19 live
 * Classic tables and the bombs off on 24, the bombs stopped inside that
 * method's 60-second throttle and the ANTES WOULD HAVE GONE ON BEING
 * COLLECTED until each engine restarted - in a game whose card says it has
 * none.
 *
 * These pins are that defect. Each one is a rule a player was sold under the
 * game's name; if one of them goes red, a table has stopped following its
 * game again.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const maybeSingle = vi.fn();
const selectSpy = vi.fn();

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => ({
    select: (cols: string) => {
      selectSpy(table, cols);
      return {
        eq: () => ({ maybeSingle }),
      };
    },
  });
  return { supabase: { from }, maintenanceSupabase: { from } };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');

/** The columns a player was sold under the game's name. */
const TEMPLATED_COLUMNS = [
  'ante_enabled',
  'ante',
  'big_blind_ante_enabled',
  'nit_game',
  'maintain_percent_min',
  'maintain_hands',
  'run_it_mode',
  'run_it_twice',
  'allow_run_it_twice',
  'run_it_twice_enabled',
  'seven_deuce_enabled',
  'straddle_enabled',
  'min_buy_in',
  'max_buy_in',
  'action_time_seconds',
];

/** An ACTION table as fn_cash_apply_ruleset writes it. */
const actionRow = {
  rake_percent: 5,
  rake_cap_bb: 3,
  bomb_pot_enabled: true,
  bomb_pot_trigger_mode: 'timed',
  bomb_pot_interval_seconds: 900,
  bomb_pot_ante_multiplier: 2,
  bomb_pot_board_count: 2,
  bomb_pot_double_board: true,
  bomb_pot_min_players: 2,
  ante_enabled: true,
  ante: 1,
  big_blind_ante_enabled: false,
  nit_game: true,
  maintain_percent_min: 30,
  maintain_hands: 10,
  career_percent_min: 0,
  run_it_mode: 'player_choice',
  run_it_twice: true,
  allow_run_it_twice: true,
  run_it_twice_enabled: true,
  insurance_enabled: false,
  seven_deuce_enabled: true,
  seven_deuce_amount: 2,
  straddle_enabled: false,
  auto_utg_straddle: false,
  voluntary_straddle: false,
  min_buy_in: 100,
  max_buy_in: 400,
  action_time_seconds: 15,
};

/** The same table after it is realigned to CLASSIC: no antes, no bombs, no floor. */
const classicRow = {
  ...actionRow,
  bomb_pot_enabled: false,
  bomb_pot_trigger_mode: 'every_n_hands',
  bomb_pot_interval_seconds: null,
  bomb_pot_board_count: 1,
  bomb_pot_double_board: false,
  ante_enabled: false,
  ante: 0,
  big_blind_ante_enabled: false,
  nit_game: false,
  maintain_percent_min: 0,
  seven_deuce_enabled: false,
  seven_deuce_amount: 0,
  min_buy_in: 80,
  max_buy_in: 400,
};

function engineOn(row: Record<string, unknown>) {
  const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-444444444444') as any;
  e.tableInfo = { id: e.tableId, club_id: 'club', game_type: 'cash', ...row };
  e.lastRakeRefreshAtMs = 0;
  return e;
}

beforeEach(() => {
  maybeSingle.mockReset();
  selectSpy.mockReset();
  // The club read that follows the table read.
  maybeSingle.mockResolvedValue({ data: null });
});
afterEach(() => vi.restoreAllMocks());

describe('refreshRakeConfig re-reads the whole templated rule set', () => {
  it('asks the database for every rule a player was sold under the game name', async () => {
    const e = engineOn(actionRow);
    maybeSingle.mockResolvedValueOnce({ data: actionRow });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    const tableSelect = selectSpy.mock.calls.find((c) => c[0] === 'tables');
    expect(tableSelect, 'the table row is read').toBeTruthy();
    const cols = String(tableSelect![1]);
    for (const column of TEMPLATED_COLUMNS) {
      expect(cols.split(/,\s*/), `${column} is in the re-read`).toContain(column);
    }
  });

  it('an Action table realigned to Classic stops charging an ante without a restart', async () => {
    const e = engineOn(actionRow);
    expect(e.tableInfo.ante_enabled).toBe(true);
    expect(e.tableInfo.ante).toBe(1);

    // fn_cash_apply_ruleset rewrites the row underneath the running engine.
    maybeSingle.mockResolvedValueOnce({ data: classicRow });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    expect(e.tableInfo.ante_enabled, 'No Antes means no antes').toBe(false);
    expect(e.tableInfo.ante).toBe(0);
    expect(e.tableInfo.big_blind_ante_enabled).toBe(false);
  });

  it('and stops running the VPIP floor, and the felt floor follows', async () => {
    const e = engineOn(actionRow);
    expect(e.vpipFloor()).toBe(30);

    maybeSingle.mockResolvedValueOnce({ data: classicRow });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    expect(e.tableInfo.nit_game, 'No VPIP Floor means the rule is off').toBe(false);
    expect(e.vpipFloor(), 'the number the horse brain steers by follows too').toBe(0);
  });

  it('and stops dealing bombs (the half that already worked, pinned so it stays)', async () => {
    const e = engineOn(actionRow);
    maybeSingle.mockResolvedValueOnce({ data: classicRow });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    expect(e.tableInfo.bomb_pot_enabled).toBe(false);
    expect(e.tableInfo.bomb_pot_trigger_mode).toBe('every_n_hands');
    expect(e.tableInfo.bomb_pot_interval_seconds).toBe(null);
  });

  it('recompiles the RIT engine from the fresh row, not the boot row', async () => {
    const e = engineOn(actionRow);
    const configure = vi.spyOn(e.runItTwiceEngine, 'configure');

    // A game whose tables disagreed on run-it: this one is switched OFF.
    maybeSingle.mockResolvedValueOnce({
      data: {
        ...actionRow,
        run_it_mode: 'none',
        run_it_twice: false,
        allow_run_it_twice: false,
        run_it_twice_enabled: false,
      },
    });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    expect(configure, 'applyRunItTwiceConfig ran after the re-read').toHaveBeenCalled();
    const last = configure.mock.calls[configure.mock.calls.length - 1][1] as any;
    expect(last.enabled, 'the offer follows the row').toBe(false);
    expect(last.mode).toBe('none');
  });

  it('leaves the previous values standing when the read fails', async () => {
    const e = engineOn(actionRow);
    maybeSingle.mockRejectedValueOnce(new Error('supabase blip'));
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();

    // A stats read that cannot answer must never change a live table's rules.
    expect(e.tableInfo.ante_enabled).toBe(true);
    expect(e.tableInfo.maintain_percent_min).toBe(30);
  });

  it('does nothing on a tournament table (its ante comes from the level)', async () => {
    const e = engineOn({ ...actionRow, tournament_id: 'tourney' });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
