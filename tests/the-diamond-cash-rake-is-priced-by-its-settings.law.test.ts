/**
 * LAW: no Diamond cash-rake door holds a number. Every one is a row.
 * ═══════════════════════════════════════════════════════════════════════════
 * docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 3.2 asks for exactly
 * this: "a law test that no Diamond money door contains a numeric literal for a
 * name on the list". Section 5 adds the rest of the shape - the engine and the
 * settler read ca_diamond_economics "and never RAKE_SPEC, ca_rake_tier or the
 * table's rake columns", the settler recomputes rather than trusting, the rake
 * accrues inside the arena float and crosses once per sweep, and it never
 * touches a chip table.
 *
 * WHY A LAW AND NOT A COMMENT. The whole value of ca_diamond_economics is that
 * Dan can change any rake number by inserting one row, with no rebuild and no
 * migration. A literal anywhere on the path quietly takes that away: the row
 * would still be there, still be read, and still be wrong, because something
 * downstream had its own copy. The estate has paid for this before - the chip
 * rake schedule was scattered across two files and a database mirror until
 * rakeSpec.ts made it one place with a boot checksum.
 *
 * Nothing here approves a rate. The rates are rows; this law is about where
 * they live.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MIGRATION = 'supabase/migrations/20261005151712_diamond_cash_rake_economics_and_accrual.sql';
const migration = read(MIGRATION);

/** The body of one function as the migration writes it.
 *
 * The open bracket matters: without it `fn_ca_diamond_economic` finds
 * `fn_ca_diamond_economic_names` first and every assertion below reads the
 * wrong function while still passing. */
function body(proname: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${proname}(`);
  expect(start, `${proname} is not defined in ${MIGRATION}`).toBeGreaterThan(-1);
  const end = migration.indexOf('$function$;', start);
  expect(end, `${proname} has no end`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

/** The same body with its comments removed, for the checks that say "never".
 *  A rule written in a comment is a rule the comment would then break. */
function code(proname: string): string {
  return body(proname)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('the Diamond cash rake is priced by its settings and by nothing else', () => {
  it('names every answer on a closed list, with its units', () => {
    const list = body('fn_ca_diamond_economic_names');
    for (const name of [
      'cash_rake_enabled',
      'cash_rake_percent',
      'cash_rake_cap_diamonds',
      'cash_rake_preflop_raked',
      'cash_rake_min_pot_diamonds',
      'cash_rake_rounding',
      'cash_rake_destination',
      'cash_rakeback_percent',
      'cash_rake_vip_points',
    ]) {
      expect(list, `${name} is not on the closed list`).toContain(`'${name}'`);
    }
    // A name off the list cannot be recorded, so the list is the schema.
    expect(body('fn_ca_diamond_economics_guard')).toContain('diamond_economics_unknown_name');
  });

  it('refuses an unset value by name, under its own SQLSTATE, and never returns NULL', () => {
    for (const reader of ['fn_ca_diamond_economic', 'fn_ca_diamond_economic_text']) {
      const src = body(reader);
      expect(src).toMatch(/diamond_economics_unset:%\/%/);
      expect(src).toContain("ERRCODE='P0D01'");
      // "It never returns NULL and never falls back to another scope, to a chip
      // value or to a literal." A COALESCE or a second scope would be the
      // fallback the design forbids.
      expect(src).not.toMatch(/RETURN\s+NULL/);
      expect(src).not.toMatch(/COALESCE\s*\(\s*v_value/);
    }
  });

  it('is append-only, so an approved answer cannot be rewritten in place', () => {
    const guard = body('fn_ca_diamond_economics_guard');
    expect(guard).toContain('diamond_economics_is_append_only');
    expect(guard).toMatch(/TG_OP IN \('UPDATE','DELETE'\)/);
    expect(body('fn_ca_diamond_rake_accrual_guard')).toContain(
      'diamond_rake_accrual_is_append_only'
    );
    expect(body('fn_ca_diamond_rake_accrual_guard')).toContain(
      'diamond_rake_accrual_is_swept_once'
    );
  });

  it('records a quote and a derivation beside every number', () => {
    expect(migration).toMatch(
      /CHECK \(length\(btrim\(approved_quote\)\) > 0 AND length\(btrim\(basis\)\) > 0\)/
    );
  });

  it('reads the settler every number and holds no literal for one', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    // Each number comes from the reader, at the scope the hand is in.
    expect(settler).toMatch(/v_pct\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_percent'/);
    expect(settler).toMatch(
      /v_cap\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_cap_diamonds'/
    );
    expect(settler).toMatch(
      /v_min_pot\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_min_pot_diamonds'/
    );
    expect(settler).toMatch(
      /v_preflop\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_preflop_raked'/
    );
    expect(settler).toMatch(
      /v_rounding\s*:=\s*public\.fn_ca_diamond_economic_text\('cash_rake_rounding'/
    );
    // THE CHIP SCHEDULE CANNOT REACH A DIAMOND HAND. Not by name, and not
    // through the table's own columns, which stay at an explicit zero for ever.
    const settlerCode = code('fn_poker_diamond_settle_cash_hand');
    for (const chip of [
      'RAKE_SPEC',
      'ca_rake_tier',
      'ca_rake_schedule',
      'ca_rake_rules',
      'fn_effective_rake',
      'ca_bbj_policy',
      'fn_rake_spec_checksum',
    ]) {
      expect(settlerCode, `the settler reads ${chip}`).not.toContain(chip);
    }
    /* The table's own deduction columns, which stay at an explicit zero for
       ever. Anchored so `cash_rake_percent` - a ca_diamond_economics NAME, and
       the only place a percentage may come from - is not mistaken for the chip
       column it ends with. */
    expect(settlerCode).not.toMatch(/\b(?:t|tables)\.(?:rake_percent|rake_cap_bb|bbj_percent)\b/);
    expect(settlerCode).not.toMatch(/(?<!cash_)\brake_cap_bb\b/);
  });

  it('recomputes the rake and refuses the engine by name when they disagree', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    expect(settler).toContain('diamond_cash_rake_disagrees');
    expect(settler).toContain('diamond_cash_rake_facts_required');
    expect(settler).toContain('diamond_cash_rake_facts_disagree');
    // Conservation is minus the rake and the drop, not zero.
    expect(settler).toMatch(/<>\s*-\(v_rake \+ COALESCE\(p_bbj,0\)\)/);
    expect(settler).toContain('diamond_hand_does_not_conserve');
    // The jackpot and insurance amounts are still held at zero.
    expect(settler).toMatch(/COALESCE\(p_bbj,0\) <> 0 OR COALESCE\(p_inflow,0\) <> 0/);
    // Only "down" is implemented, and a row saying otherwise refuses rather
    // than being approximated.
    expect(settler).toContain('diamond_cash_rake_rounding_unsupported');
  });

  it('attributes by contribution, in whole Diamonds, and proves the shares sum', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    expect(settler).toContain('ca_diamond_rake_accrual');
    // The remainder rule the design asks the migration to state and pin:
    // floor of the proportional share, then one Diamond each to the largest
    // remainders, ties by user_id ascending.
    expect(settler).toMatch(/div\(v_rake \* contributed, v_pot\)/);
    expect(settler).toMatch(/\(v_rake \* contributed\) % v_pot/);
    expect(settler).toMatch(/ORDER BY frac DESC, uid ASC/);
    expect(settler).toContain('diamond_cash_rake_attribution_does_not_sum');
  });

  it('leaves no is_horse filter anywhere on the rake path (CLAUDE.md 10.5)', () => {
    // A horse earns and is paid everything a human is from the same action,
    // including anything rake-derived. An earlier agent's invented is_horse
    // filter in a rake function cost 39 tournaments their whole attribution.
    for (const proname of [
      'fn_poker_diamond_settle_cash_hand',
      'fn_ca_diamond_sweep_cash_rake',
      'fn_ca_arena_diamonds',
    ]) {
      expect(code(proname), `${proname} filters horses`).not.toMatch(/is_horse|horses?_only/i);
    }
  });

  it('counts unswept rake inside the arena float, and swept rake nowhere twice', () => {
    const float = body('fn_ca_arena_diamonds');
    expect(float).toContain('ca_diamond_rake_accrual');
    expect(float).toMatch(/swept_at IS NULL/);
  });

  it('crosses to its destination once per sweep, not once per hand', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    // R4: no house write on the per-hand path at all.
    expect(settler).not.toContain('ca_diamond_house');
    const sweep = body('fn_ca_diamond_sweep_cash_rake');
    expect(sweep).toContain('ca_diamond_house');
    expect(sweep).toMatch(/fn_ca_diamond_economic_text\('cash_rake_destination'/);
    // R2: the payer's spend row plus a house mint, and the register checked.
    expect(sweep).toContain('diamond_transactions');
    expect(sweep).toContain('ca_mint_ledger');
    expect(sweep).toContain('diamond_cash_rake_not_retired_from_players');
    // The identity is asserted after the crossing, every time.
    expect(sweep).toContain('fn_ca_diamond_register_vs_supply');
  });

  it('is the product design and not a repair loop: no cron is installed', () => {
    // CLAUDE.md 10.12. The sweep exists because per-hand money must not
    // serialize on ca_diamond_house row 1 (design R4), not to clean up after a
    // defect, and nothing here schedules it.
    expect(migration).not.toMatch(/cron\.schedule|pg_cron|cron\.unschedule/);
  });

  it('never lets a Diamond rake reach a chip rake table, so B13 is no by construction', () => {
    expect(body('fn_ca_reject_diamond_chip_rake_row')).toContain(
      'Diamond Rake Is Never A Chip Rake Record'
    );
    for (const table of [
      'rake_records',
      'rake_attributions',
      'rake_distribution_legs',
      'club_wallets',
    ]) {
      expect(migration, `${table} is not fenced`).toContain(`'${table}'`);
    }
  });

  it('declares the watched settler it redefines', () => {
    expect(migration).toMatch(
      /fn_ca_declare_guard_redefinition\(\s*'fn_poker_diamond_settle_cash_hand'/
    );
  });

  it('never opens the cash-game door', () => {
    expect(migration).toMatch(/cash_games_enabled is open and this migration must never be/);
    expect(migration).not.toMatch(/UPDATE\s+public\.ca_arena_settings/);
  });

  it('is proved on an isolated cluster through the real doors', () => {
    const runner = read('tests/sql/run-diamond-cash-rake.py');
    expect(runner).toContain(MIGRATION.split('/').pop());
    // The BEFORE case must run against the INSTALLED door, or the regression
    // only ever passes.
    expect(runner).toContain('3aab9170062e97840afc7d15999691ad');
    expect(runner).toContain('an error is the success case');
  });
});
