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
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const FORM = path.join(process.cwd(), 'src', 'pages', 'TableConfigPage.tsx');
const source = fs.readFileSync(FORM, 'utf8');
/** The file minus its doc comments — the removed names are NAMED in those. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

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
  // NOTE 2026-08-31, corrected in the same day. min_buy_in_bb / max_buy_in_bb
  // were listed here on the strength of 20260828_cash_buyins_are_40bb_to_200bb
  // .sql, which resynced them "so the two column families cannot disagree".
  // Phase 2 of the live cash audit then went further and settled it with a
  // database census: no function, view, constraint or policy touches either
  // column, the only writer was this form, and the 2/25 sitting on 103,684 of
  // 103,690 rows is the 010_table_configuration default rather than a stale
  // copy of the truth. They are no longer written; the band is derived from
  // min_buy_in / max_buy_in, which is what atomic_table_buyin and the engine
  // actually read. See docs/changelog/2026-08-31-one-buy-in-band.md and
  // tests/unit/buyInBandIsOneColumnPair.test.ts, which owns that pin now.
  // Real readers in lobbyEntries, TablePage and HorseOrchestrator.
  'ante_bb',
];

describe('5a — the three lifecycle switches are read in SQL and stay', () => {
  it.each(['Auto Restart', 'Auto Extension', 'Auto Create Table'])(
    'still offers the "%s" toggle',
    (label) => {
      expect(code).toContain(`label="${label}"`);
    }
  );

  it.each(['auto_restart', 'auto_extension', 'auto_create_table'])(
    'still writes %s, which fn_table_lifecycle_pass reads',
    (column) => {
      expect(code).toMatch(new RegExp(`^\\s*${column}: config\\.`, 'm'));
    }
  );
});

describe('5b — the tournament block is not written onto a cash row', () => {
  it.each(DEAD_ON_A_CASH_ROW)('no longer writes %s', (column) => {
    expect(code).not.toMatch(new RegExp(`^\\s*${column}:`, 'm'));
  });

  it.each(ALIVE_DESPITE_APPEARANCES)('still writes %s, which has live readers', (column) => {
    expect(code).toMatch(new RegExp(`^\\s*${column}:`, 'm'));
  });
});

describe('5c — the Pineapple switch exists and matches the engine gate', () => {
  it('offers the control the engine has always honoured', () => {
    expect(code).toContain(`label="Pineapple Hold'em"`);
    expect(code).toContain("updateConfig('pineappleHoldem'");
  });

  it('offers it only where ServerTableEngineBase will deal it', () => {
    // dealtGameVariant: pineapple_holdem is honoured on 'nlh' and 'nlhe' only,
    // "because Pineapple PLO is not a game".
    expect(code).toMatch(/PINEAPPLE_VARIANTS = new Set\(\['nlh', 'nlhe'\]\)/);
    expect(code).toContain('{canDealPineapple(gameType) && (');
  });

  it('cannot leave a stale true on a variant the engine ignores', () => {
    expect(code).toMatch(
      /pineapple_holdem:\s*canDealPineapple\(gameType\) \? config\.pineappleHoldem : false/
    );
  });
});

describe('5d — the 7-2 amount is gated exactly like the 7-2 switch', () => {
  it('writes the default amount off a variant that can never pay the bounty', () => {
    // The switch was gated and the amount was not, so a PLO6 table created
    // after loading an NLH template wrote enabled:false beside amount:8.
    const amount = code.match(/seven_deuce_amount:[\s\S]{0,220}?,\n/);
    expect(amount).not.toBeNull();
    expect(amount?.[0]).toContain('SEVEN_DEUCE_VARIANTS.has');
    expect(amount?.[0]).toContain('config.sevenDeuceEnabled');
  });
});
