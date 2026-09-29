/**
 * KILL POTS (kill-v1): THE THROTTLED RULE RE-READ SURVIVES A DATABASE WITHOUT
 * THE KILL COLUMNS, AND A KILL READ THAT CANNOT ANSWER CHANGES NOTHING.
 *
 * refreshRakeConfig re-reads the whole templated rule set once a minute. Had
 * the kill columns been named in that read, a database without migration
 * 20260924034010 would fail it with 42703 - and because the read's error is
 * not inspected, EVERY rule (antes, bombs, run-it, the VPIP floor) would
 * silently stop following the row. So kill is read beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  selects: [] as Array<{ table: string; columns: string }>,
  rules: { data: null as unknown, error: null as unknown },
  kill: { data: null as unknown, error: null as unknown },
  history: { data: null as unknown, error: null as unknown },
}));

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => (table === 'hand_history' ? historyChain() : tableChain(table));
  const historyChain = () => {
    const chain: any = {
      select: (columns: string) => {
        io.selects.push({ table: 'hand_history', columns });
        return chain;
      },
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => io.history,
    };
    return chain;
  };
  const tableChain = (table: string) => ({
    select: (columns: string) => {
      io.selects.push({ table, columns });
      return {
        eq: () => ({
          maybeSingle: async () => {
            if (table !== 'tables') return { data: null, error: null };
            return columns === 'kill_mode, kill_threshold_bb' ? io.kill : io.rules;
          },
        }),
      };
    },
  });
  return { supabase: { from }, maintenanceSupabase: { from } };
});
const reported = vi.hoisted(() => vi.fn());
vi.mock('../services/errorReporter.js', () => ({ reportError: reported }));

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { resetKillColumnsAbsentReportForTests } = await import('../services/supabase/tables.js');

/** A Classic fixed-limit table as fn_cash_apply_ruleset writes it. */
const classicRow = {
  rake_percent: 5,
  rake_cap_bb: 3,
  bomb_pot_enabled: false,
  ante_enabled: false,
  ante: 0,
  nit_game: false,
  maintain_percent_min: 0,
  maintain_hands: 10,
  run_it_mode: 'player_choice',
  run_it_twice: true,
  allow_run_it_twice: true,
  run_it_twice_enabled: true,
  min_buy_in: 8,
  max_buy_in: 40,
  action_time_seconds: 15,
};

function engineOn(row: Record<string, unknown>) {
  const e = new ServerTableEngine('aaaaaaaa-1111-2222-3333-555555555555') as any;
  e.tableInfo = {
    id: e.tableId,
    club_id: 'club',
    game_type: 'cash',
    game_variant: 'flh',
    big_blind: 0.1,
    ...row,
  };
  e.lastRakeRefreshAtMs = 0;
  return e;
}

beforeEach(() => {
  io.selects = [];
  io.history = { data: null, error: null };
  io.rules = { data: classicRow, error: null };
  io.kill = { data: { kill_mode: 'full', kill_threshold_bb: 12 }, error: null };
  reported.mockReset();
  resetKillColumnsAbsentReportForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('refreshRakeConfig and the kill columns', () => {
  it('never names the kill columns in the rule-set read', async () => {
    const e = engineOn({ ante_enabled: true, ante: 0.05 });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    const ruleRead = io.selects.find(
      (s) => s.table === 'tables' && s.columns !== 'kill_mode, kill_threshold_bb'
    );
    expect(ruleRead, 'the rule set is read').toBeTruthy();
    expect(ruleRead!.columns.split(/,\s*/)).not.toContain('kill_mode');
    expect(ruleRead!.columns.split(/,\s*/)).not.toContain('kill_threshold_bb');
    expect(io.selects.filter((s) => s.columns === 'kill_mode, kill_threshold_bb')).toHaveLength(1);
  });

  it('the kill setting follows the row at the next re-read', async () => {
    const e = engineOn({ kill_mode: 'off', kill_threshold_bb: 10 });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo.kill_mode).toBe('full');
    expect(e.tableInfo.kill_threshold_bb).toBe(12);
    expect(e.killSettingsFromTable()).toEqual({ mode: 'full', thresholdBb: 12 });
  });

  it('on a database without the columns every other rule still follows the row, and kill is off', async () => {
    io.kill = {
      data: null,
      error: { code: '42703', message: 'column tables.kill_mode does not exist' },
    };
    const e = engineOn({
      ante_enabled: true,
      ante: 0.05,
      nit_game: true,
      maintain_percent_min: 20,
    });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo.ante_enabled, 'the ante still follows the row').toBe(false);
    expect(e.tableInfo.nit_game).toBe(false);
    expect(e.tableInfo.kill_mode).toBe('off');
    expect(e.killSettingsFromTable().mode).toBe('off');
    expect(reported).not.toHaveBeenCalled();
  });

  it('a kill read that fails for any other reason is reported and changes nothing', async () => {
    io.kill = { data: null, error: { code: '57014', message: 'statement timeout' } };
    const e = engineOn({ kill_mode: 'half', kill_threshold_bb: 8, ante_enabled: true, ante: 0.05 });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(reported).toHaveBeenCalledTimes(1);
    expect(String(reported.mock.calls[0][1])).toContain('kill_settings_read_failed');
    // Unknown is not off: the configured kill stands ...
    expect(e.tableInfo.kill_mode).toBe('half');
    expect(e.tableInfo.kill_threshold_bb).toBe(8);
    // ... and the rest of the rule set still followed the row.
    expect(e.tableInfo.ante_enabled).toBe(false);
  });

  it('a kill row that is missing leaves the configured kill standing', async () => {
    io.kill = { data: null, error: null };
    const e = engineOn({ kill_mode: 'full', kill_threshold_bb: 15 });
    await e.refreshRakeConfig(true);
    e.preciseTimer?.dispose?.();
    expect(e.tableInfo.kill_mode).toBe('full');
    expect(e.tableInfo.kill_threshold_bb).toBe(15);
  });
});

describe('restoreKillFromHistory and hand_history.kill_pot', () => {
  it('a database without the column has no kill to restore, and does not warn about it', async () => {
    io.history = {
      data: null,
      error: { code: '42703', message: 'column hand_history.kill_pot does not exist' },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = engineOn({ kill_mode: 'full', kill_threshold_bb: 10 });
    await e.restoreKillFromHistory();
    e.preciseTimer?.dispose?.();
    expect(io.selects.map((s) => s.table)).toEqual(['hand_history']);
    expect(e.killSchedule.getPending()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('any other failure still says it could not restore', async () => {
    io.history = { data: null, error: { code: '57014', message: 'statement timeout' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = engineOn({ kill_mode: 'full', kill_threshold_bb: 10 });
    await e.restoreKillFromHistory();
    e.preciseTimer?.dispose?.();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Could not restore a pending kill');
  });
});
