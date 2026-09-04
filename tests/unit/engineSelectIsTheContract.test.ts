/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ENGINE'S SELECT LIST IS THE CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "MAKE SURE THAT ALL OF THESE ARE ADDED AS OPTIONS AND ARE
 * FULLY BUILT OUT AND IMPLEMENTED."
 *
 * An audit of all forty-six creation controls found twenty-two that were
 * switches wired to nothing, and the cause was almost always the same single
 * line: `loadTable()` in server/src/services/supabase/tables.ts fetches an
 * explicit column list, and A COLUMN OUTSIDE THAT LIST CANNOT CHANGE A HAND no
 * matter who writes it. The Ante slider is the clearest case — it wrote
 * `ante_bb`, which the engine has never selected, so ante was dead on every
 * table that page created and nothing anywhere said so.
 *
 * This file is the guard. Any column named as gameplay below must appear in
 * the select list, so the next feature wired to an invisible column fails here
 * instead of in production, silently, for six months.
 *
 * IT DOES NOT ASSERT THAT A FEATURE IS ENFORCED. Being fetched is necessary
 * and not sufficient — `voluntary_straddle` is fetched and never branched on.
 * The audit tracks enforcement; this tracks reachability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceCall } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** The select string out of loadTable, parsed into column names. */
const SELECTED: string[] = (() => {
  const src = read('server/src/services/supabase/tables.ts');
  const start = src.indexOf("'id, club_id,");
  expect(start, 'the loadTable select literal has moved or been renamed').toBeGreaterThan(-1);
  const end = src.indexOf("'", start + 1);
  return src
    .slice(start + 1, end)
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
})();

/**
 * Columns that decide how a HAND plays. Every one must be reachable by the
 * engine. Add to this list whenever a control is wired up, and the guard does
 * the rest.
 */
const GAMEPLAY_COLUMNS = [
  // Structure
  'small_blind',
  'big_blind',
  'ante',
  'ante_enabled',
  'game_variant',
  'max_players',
  'action_time_seconds',
  'all_in_or_fold',
  // Money
  'min_buy_in',
  'max_buy_in',
  'rake_percent',
  'rake_cap_bb',
  // Features a host can switch on
  'straddle_enabled',
  'auto_utg_straddle',
  'run_it_twice',
  'run_it_twice_enabled',
  'allow_run_it_twice',
  'insurance_enabled',
  'bomb_pot_enabled',
  'bomb_pot_frequency',
  // BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec §3): the canonical
  // config surface — board count 1-3, trigger mode, timed interval, minimum
  // players and fixed ante. Wired to BombPotScheduler + HandController.
  'bomb_pot_board_count',
  'bomb_pot_trigger_mode',
  'bomb_pot_interval_seconds',
  'bomb_pot_min_players',
  'bomb_pot_ante_fixed',
  // VARIANT OVERRIDE + TIMED PERSISTENCE 2026-08-28 (spec §10.1/§4.3)
  'bomb_pot_variant',
  'bomb_pot_next_due_at',
  // BOMB POT MAX 2026-08-28: scheduler state, button policy, announce window
  'bomb_pot_sched_state',
  'bomb_pot_button_policy',
  'bomb_pot_announce_seconds',
  'seven_deuce_enabled',
  'time_bank_enabled',
  'wait_for_big_blind',
  // Wired up 2026-08-25
  'auto_start_players',
  'run_it_mode',
  'is_anonymous',
  'ban_chat',
  'restrict_observers',
  'cap_enabled',
  'cap_bb',
];

describe('every gameplay column is reachable by the engine', () => {
  for (const col of GAMEPLAY_COLUMNS) {
    it(`${col} is in the loadTable select`, () => {
      expect(SELECTED).toContain(col);
    });
  }
});

describe('the columns the Ante bug taught us about', () => {
  it('ante_bb is still NOT selected, so it must never be the only ante write', () => {
    // It is the authored unit (big blinds) and is deliberately not fetched.
    // TableConfigPage writes it AND derives `ante` from it; if that derivation
    // is ever removed, the ante silently dies again.
    expect(SELECTED).not.toContain('ante_bb');
    // 2026-09-04 (Operation Table Stakes, Slice 1): the cash writer is
    // fn_cash_game_create in SQL, which derives ante_enabled and ante from
    // the same chips figure it stores as ante_bb.
    const sql = read('supabase/migrations/20260904160500_cash_games_slice_1.sql');
    expect(sql).toMatch(/ante_enabled, ante, ante_bb,/);
    expect(sql).toMatch(/v_ante_chips > 0, v_ante_chips,/);
  });
});

describe('the settings JSONB is not a contract', () => {
  it('the engine never reads tables.settings', () => {
    // All 46 live cash tables carry `settings = {}`. Anything a creation
    // surface puts only in there is invisible to the game.
    const loader = read('server/src/services/supabase/tables.ts');
    expect(SELECTED).not.toContain('settings');
    expect(loader).not.toMatch(/\.settings\b/);
  });
});

describe('AutoStart is one predicate, shared', () => {
  const base = read('server/src/engine/ServerTableEngineBase.ts');
  const dealing = read('server/src/engine/ServerTableEngineDealing.ts');
  const turns = read('server/src/engine/ServerTableEngineTurns.ts');

  it('reads the host figure and clamps it at two', () => {
    expect(base).toContain('protected minPlayersToDeal()');
    expect(base).toContain('auto_start_players');
    // A hand of one is not a hand, and the column has no CHECK constraint.
    expect(base).toMatch(/configured > 2 \? Math\.floor\(configured\) : 2/);
  });

  it('a tournament table ignores the cash slider', () => {
    const fn = sliceMethod(base, 'protected minPlayersToDeal()');
    expect(fn).toContain('isTournamentTable()');
  });

  it('the loop and the watchdog use the SAME predicate', () => {
    // They must agree or the watchdog kills a table that is legitimately
    // waiting for its third seat, every ninety seconds, forever.
    expect(dealing).toContain('activePlayers.length < this.minPlayersToDeal()');
    expect(turns).toContain('dealable >= this.minPlayersToDeal()');
    expect(turns).not.toMatch(/dealable >= 2\b/);
  });
});

describe('mandatory run-it modes are additive, never subtractive', () => {
  const rit = read('server/src/engine/RunItTwiceEngine.ts');
  const base = read('server/src/engine/ServerTableEngineBase.ts');
  const runout = read('server/src/engine/ServerTableEngineRunout.ts');

  it('forces two or three runs and asks nobody', () => {
    expect(rit).toContain('mandatoryRuns(tableId: string)');
    expect(rit).toContain('forceRuns(');
    expect(runout).toContain(
      'const forcedRuns = this.runItTwiceEngine.mandatoryRuns(this.tableId)'
    );
  });

  it('builds the state dealDualBoards actually requires', () => {
    const fn = rit.slice(rit.indexOf('forceRuns('));
    expect(fn).toContain("status: 'accepted'");
    expect(fn).toContain('chooserDecided: true');
    expect(fn).toContain('acceptedBy: new Set(allPlayerIds)');
  });

  it('does NOT gate `enabled` on the mode', () => {
    /**
     * run_it_mode is the string 'none' on all 46 live tables while
     * run-it-twice is genuinely ON via the three boolean columns. A mode that
     * gated `enabled` would have switched the feature off platform-wide. The
     * mode may only ever remove the QUESTION.
     */
    const cfg = sliceCall(base, 'this.runItTwiceEngine.configure(');
    expect(cfg).toContain('enabled: ritEffective');
    expect(cfg).not.toMatch(/enabled:\s*ritEffective\s*&&/);
  });
});
