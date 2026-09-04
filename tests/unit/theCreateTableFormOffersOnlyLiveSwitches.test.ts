/**
 * A SWITCH THAT DOES NOTHING IS WORSE THAN NO SWITCH.
 *
 * This repo keeps recording the same shape: a control on the create-table
 * form writes a `tables` column that NOTHING reads, and the owner who ticks
 * it believes in it. Seven security switches (2026-08-19), triple_board and
 * Calltime and Game Length (2026-08-27). The mirror image is just as bad:
 * `pineapple_holdem` is a fully dealt variant — three hole cards, its own
 * discard street, a lobby badge — and the only live cash-creation path had NO
 * CONTROL for it at all.
 *
 * AND THE TRAP, which cost this audit a wrong deletion before the existing
 * tableLifecycleSwitches pin caught it: a TypeScript grep is not a reader
 * census. `auto_restart` and `auto_create_table` have zero readers in src/
 * and server/src/ and are read by fn_table_lifecycle_pass IN SQL — confirmed
 * against the deployed function, not a migration file. Before calling a
 * column dead, grep supabase/migrations too, and then read the live object.
 *
 * These are source-level assertions on purpose. The defect is what the form
 * OFFERS and what it WRITES, and both are visible in the file. Same technique
 * as oneTableWriter.test.ts.
 *
 * 2026-09-04 (Operation Table Stakes, Slice 1): the cash writer moved out of
 * TableConfigPage.buildTableData and into SQL. fn_cash_game_create projects
 * the resolved ruleset snapshot onto the SAME engine columns, so every pin
 * below now reads the INSERT in that migration instead of a TSX object
 * literal. What the form OFFERS is now CashGameCreateFlow.tsx.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const SQL = read('supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql');
const FLOW = read('src/components/cash/CashGameCreateFlow.tsx');
const VOCAB = read('src/config/cashGames.ts');

/** The column list of the one INSERT INTO public.tables the create function makes. */
const insertColumns = (() => {
  const at = SQL.indexOf('INSERT INTO public.tables (');
  const close = SQL.indexOf(') VALUES (', at);
  if (at < 0 || close < 0) throw new Error('fn_cash_game_create: tables INSERT not found');
  return SQL.slice(at, close)
    .replace('INSERT INTO public.tables (', '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
})();

/** Columns written on a cash row with zero readers anywhere. */
const DEAD_ON_A_CASH_ROW = [
  'sng_buy_in',
  'sng_custom_buy_in',
  'blinds_up_minutes',
  'next_step_satellite',
  'custom_rebuy_reentry_cost',
  'number_of_rebuys_reentries',
  'add_on_multiplier',
  'custom_add_on',
  'add_on_break_length_minutes',
  'ko_bounty',
  'gtd_prize_pool',
  'late_registration_level',
  'early_bird_registration',
  'featured_tournament',
  'min_players_mtt',
  'max_players_mtt',
  'multi_day_mtt',
  'save_start_time',
  'restart_tournament_every',
  'tournament_schedule',
  // 2026-08-29: true on 0 of 97,944 rows; the engine reads bomb_pot_double_board.
  'double_board',
  // 2026-09-04: pineapple is a dealt VARIANT now (game_variant = 'pineapple'),
  // so the flag that used to turn an NLH table into one is never written and
  // can never go stale on a PLO row.
  'pineapple_holdem',
];

/**
 * Columns that LOOK dead from a TypeScript grep and are not. Each was checked
 * against supabase/migrations before this list was written. Deleting one of
 * these is the regression this pin exists to catch.
 */
const ALIVE_DESPITE_APPEARANCES = [
  // fn_table_lifecycle_pass reads all three, in SQL.
  'auto_restart',
  'auto_extension',
  'auto_create_table',
  // Five club-data RPCs: COALESCE(t.game_mode,'') ILIKE '%mixed%'.
  'game_mode',
  // Real readers in lobbyEntries, TablePage and HorseOrchestrator.
  'ante_bb',
];

/**
 * DERIVED COLUMNS. WRITING ONE IS AN ERROR, NOT A PREFERENCE (2026-08-31).
 *
 * 20260831133000_one_buy_in_band_and_the_rest_are_derived.sql made all four
 * GENERATED ALWAYS ... STORED from the canonical chips pair, so Postgres
 * itself refuses a write with 428C9. A create function that names one of
 * these does not write a stale value, it breaks table creation outright.
 */
const DERIVED_AND_UNWRITABLE = ['min_buy_in_bb', 'max_buy_in_bb', 'min_buyin', 'max_buyin'];

describe('5a — the three lifecycle switches are read in SQL and stay written', () => {
  it.each(['auto_restart', 'auto_extension', 'auto_create_table'])(
    'still writes %s, which fn_table_lifecycle_pass reads',
    (column) => {
      expect(insertColumns).toContain(column);
    }
  );

  it('but no longer OFFERS them: the cluster lifecycle is autonomous (OPORD 1.4 section 18)', () => {
    for (const label of ['Auto Restart', 'Auto Extension', 'Auto Create Table']) {
      expect(FLOW).not.toContain(`label="${label}"`);
    }
    // R3: Main 1 is always on. auto_extension keeps it open, auto_restart
    // reopens it; auto_create_table stays off because the pass's clone
    // would not carry cluster_id.
    expect(SQL).toMatch(/auto_extension, auto_restart, auto_create_table,/);
    // R9: a must-move game keeps Main 1 alive; a manual table does not.
    expect(SQL).toMatch(/^\s*v_must_move, v_must_move, false,\s*$/m);
  });
});

describe('5b — the tournament block is not written onto a cash row', () => {
  it.each(DEAD_ON_A_CASH_ROW)('does not write %s', (column) => {
    expect(insertColumns).not.toContain(column);
  });

  it.each(ALIVE_DESPITE_APPEARANCES)('still writes %s, which has live readers', (column) => {
    expect(insertColumns).toContain(column);
  });

  it.each(DERIVED_AND_UNWRITABLE)(
    'does not write %s, which the database now generates',
    (column) => {
      expect(
        insertColumns,
        `${column} is GENERATED ALWAYS since ` +
          '20260831133000_one_buy_in_band_and_the_rest_are_derived.sql. Writing it ' +
          'raises 428C9 and breaks table creation. Write min_buy_in / max_buy_in ' +
          '(chips) instead; the big-blind columns follow.'
      ).not.toContain(column);
    }
  );

  it('still writes the canonical chips pair the engine actually enforces', () => {
    // The inverted pins above only say what must NOT be written. Without this,
    // deleting the real band would turn the whole block green.
    expect(insertColumns).toContain('min_buy_in');
    expect(insertColumns).toContain('max_buy_in');
    // In chips: the band is authored in big blinds and multiplied out here.
    expect(SQL).toMatch(/round\(p_bb \* v_min_bb, 2\), round\(p_bb \* v_max_bb, 2\)/);
  });
});

describe('5c — Pineapple is a variant the picker offers and the engine deals', () => {
  it('offers the control the engine has always honoured - as a variant card', () => {
    expect(VOCAB).toMatch(/id: 'pineapple'/);
  });

  it('offers it only where ServerTableEngineBase will deal it', () => {
    // game_variant = 'pineapple' is dealt as pineapple outright; the create
    // function refuses anything outside the dealt list (VARIANT_UNAVAILABLE).
    const engine = read('server/src/engine/ServerTableEngineBase.ts');
    expect(engine).toContain("if (variant === 'pineapple') return 'pineapple';");
    expect(SQL).toMatch(
      /IF v_v NOT IN \('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple'\) THEN/
    );
  });

  it('cannot leave a stale true on a variant the engine ignores', () => {
    // There is no flag to leave stale: pineapple_holdem is not written.
    expect(insertColumns).not.toContain('pineapple_holdem');
    expect(FLOW).not.toContain('pineapple_holdem');
  });
});

describe('5d — the 7-2 amount is gated exactly like the 7-2 switch', () => {
  it('writes the default amount off a variant that can never pay the bounty', () => {
    // The switch was gated and the amount was not, so a PLO6 table created
    // after loading an NLH template wrote enabled:false beside amount:8.
    // Now: the snapshot forces the flag false off NLH, and the amount is a
    // CASE on that same flag.
    expect(SQL).toMatch(
      /'seven_deuce_enabled', public\.fn_cash_override_bool\(v_oo, 'seven_deuce_enabled', false\) AND v_v = 'nlh'/
    );
    expect(SQL).toMatch(/CASE WHEN \(v_opts->>'seven_deuce_enabled'\)::boolean THEN 2 ELSE 0 END/);
    // And the form only offers the switch on NLH.
    expect(FLOW).toMatch(/\{variant === 'nlh' && \(/);
  });
});
