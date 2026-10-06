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

const MIGRATION =
  'supabase/migrations/20261005183028_diamond_cash_rake_reads_the_owner_settings.sql';
const migration = read(MIGRATION);

/* The version that merged and then refused itself on apply, committing nothing.
   It must stay marked and must never run. */
const SUPERSEDED = 'supabase/migrations/20261005151712_diamond_cash_rake_economics_and_accrual.sql';

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
  it('builds no settings table of its own: it extends the one the estate has', () => {
    /* TWO LANES ANSWERING ONE DESIGN BUILT ONE TABLE TWICE, and PostgreSQL
       caught it inside a transaction that rolled back. The first attempt
       (20261005151712) created ca_diamond_economics and its reader because
       neither existed when it was written; the A-lane applied 20261005151918
       while it sat in CI. This file must never be that mistake again: the
       settings table, the units rule, the closed name list and the two readers
       are the A-lane's, and this migration only writes rows into them. */
    expect(migration).not.toMatch(/CREATE TABLE[^;]*ca_diamond_economics/);
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_diamond_economic(_text|_on|_names)?\s*\(/
    );
    expect(migration).not.toMatch(/ALTER TABLE public\.ca_diamond_economics/);
    // It writes rows, and it reads them back through the readers that exist.
    expect(migration).toMatch(/INSERT INTO public\.ca_diamond_economics/);
    expect(migration).toMatch(/fn_ca_diamond_economic_on\('cash_rake_enabled'/);
  });

  it('keeps the superseded first attempt marked, and never lets it run', () => {
    const lines = read(SUPERSEDED).split('\n');
    /* THE MARKER IS THE FIRST LINE, and the version on it is BARE.
       check-migrations-are-live reads it with /^--\s*SUPERSEDED BY\s+(\d{14})\b/m,
       and \b between a digit and an underscore never matches - both are word
       characters. A marker that read "SUPERSEDED BY 20261005183028_diamond_..."
       would look correct to a reader and be invisible to the checker, so the
       law holds the exact expression the checker uses. */
    expect(lines[0]).toMatch(/^--\s*SUPERSEDED BY\s+20261005183028\b/);
    /* "must never run" belongs in the leading comment block, which ends at the
       first line that is neither a comment nor blank. Bounded by that
       structure, never by a byte count. */
    const firstStatement = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(firstStatement).toBeGreaterThan(0);
    expect(lines.slice(0, firstStatement).join('\n')).toContain('THIS FILE MUST NEVER RUN');
  });

  it('uses the shared closed list own names for every answer', () => {
    /* The name is the contract. A name this list does not hold cannot be
       inserted at all (the A-lane's units rule returns NULL and the units CHECK
       fails), so a misspelling here is a refused migration rather than a row
       nobody reads - but the law states the fourteen so a rename has to come
       here too. */
    for (const name of [
      'cash_rake_enabled',
      'cash_rake_percent',
      'cash_rake_percent_heads_up',
      'cash_rake_percent_three_handed',
      'cash_rake_cap',
      'cash_rake_cap_heads_up',
      'cash_rake_cap_three_handed',
      'cash_rake_no_flop_no_drop',
      'cash_rake_min_pot',
      'cash_rake_rounding',
      'cash_rake_destination',
      'rakeback_percent',
      'rakeback_period',
      'rake_earns_vip_points',
    ]) {
      expect(migration, `${name} is not recorded`).toContain(`'${name}'`);
    }
  });

  it('asks the dealt-in bracket by name and the stake by scope, never the reverse', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    /* The shared table's scope grammar is 'all' or ^bb:[0-9]+$ and nothing
       else, so a stake key stays a stake key and the bracket rides on the
       name. The first attempt invented 'bb:20/dealt:2', which that grammar
       refuses outright. */
    expect(settler).toMatch(/v_dealt_key := CASE WHEN v_dealt <= 2 THEN '_heads_up'/);
    expect(settler).toMatch(/'cash_rake_cap'\|\|v_dealt_key, 'bb:'\|\|v_bb::text/);
    expect(settler).not.toContain('dealt:');
  });

  it('records a quote and a derivation beside every number', () => {
    /* The shared table REFUSES an empty quote or basis by CHECK constraint, so
       this law's job is that every row this file writes actually fills them
       rather than passing the constraint with a space. */
    const rows = migration.split('INSERT INTO public.ca_diamond_economics').slice(1).join('');
    expect(rows).toContain('NOTHING IS MINE, EVER');
    for (const marker of [
      'B4.',
      'B5.',
      'B6.',
      'B7.',
      'B8.',
      'B9.',
      'B10.',
      'B11.',
      'B12.',
      'B13.',
    ]) {
      expect(rows, `no derivation recorded for ${marker}`).toContain(marker);
    }
  });

  it('reads the settler every number and holds no literal for one', () => {
    const settler = body('fn_poker_diamond_settle_cash_hand');
    // Each number comes from the reader, at the scope the hand is in.
    expect(settler).toMatch(
      /v_pct\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_percent'\|\|v_dealt_key/
    );
    expect(settler).toMatch(
      /v_cap\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_cap'\|\|v_dealt_key/
    );
    expect(settler).toMatch(/v_min_pot\s*:=\s*public\.fn_ca_diamond_economic\('cash_rake_min_pot'/);
    expect(settler).toMatch(
      /v_no_drop\s*:=\s*public\.fn_ca_diamond_economic_on\('cash_rake_no_flop_no_drop'/
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

  /* ═══ THE ENGINE SIDE OF THE SAME LAW (2026-10-06) ═══════════════════════
     Section 5 asks that the ENGINE and the settler both read
     ca_diamond_economics "and never RAKE_SPEC, ca_rake_tier or the table's
     rake columns". Until this lane there was nothing on the engine side to
     hold to it: no TypeScript file mentioned a single one of these names, the
     engine's only pricer was the chip ladder in config/rakeSpec.ts, and every
     Diamond cash hand therefore declared a rake of zero and refused on the
     settler's recompute. Now that a Diamond pricer exists, the same law
     applies to it, and the whole value of the settings table depends on it:
     one INSERT must change the answer, with no rebuild. */

  const PRICER = 'server/src/domain/diamondCashRakeSchedule.ts';
  const READER = 'server/src/services/supabase/diamondCashRakeSettings.ts';
  const CONTROLLER = 'server/src/engine/HandController.ts';
  const BOUNDARY = 'server/src/domain/DiamondCashBoundary.ts';

  /** One file's TypeScript with its comments removed. A rule written in a
   *  comment is a rule the comment would then break. */
  function ts(path: string): string {
    return read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  it('holds no published rake number anywhere in the engine', () => {
    const code = ts(PRICER) + '\n' + ts(READER);
    /* THE WHOLE LADDER, and the three percents, as the owner published them.
       Not one of them may appear as a literal: the row is the number. */
    for (const published of [
      5, 30, 37, 75, 150, 250, 300, 375, 400, 500, 625, 750, 800, 1250, 1500, 2000,
    ]) {
      expect(
        new RegExp(`(?<![0-9.])${published}(?![0-9.])`).test(code),
        `${published} is a published Diamond rake answer and must not be a literal in the engine`
      ).toBe(false);
    }
    /* And no ladder, under any spelling: a stake rung is a SCOPE built from
       the table's own big blind, never a key in a table of numbers. */
    expect(code).not.toMatch(/bb:(?!\$\{|'|")/);
    expect(code).toMatch(/`bb:\$\{bigBlind\}`/);
  });

  it('declares exactly two numeric constants, and says what each one means', () => {
    /* A percent is per hundred and a decimal digit is worth ten of the next.
       Those two are the DEFINITIONS OF THE WORDS and cannot be rows. Every
       other number in the pricer is accounted for here, by name and reason,
       so a third constant cannot arrive unnoticed. */
    const code = ts(PRICER);
    expect(code).toMatch(/const PER_CENT = 100n;/);
    expect(code).toMatch(/const RADIX = 10n;/);
    /* ... and those are the ONLY places those digits appear. */
    expect(code.match(/(?<![0-9A-Za-z_.$])100n(?![0-9A-Za-z_.])/g)).toHaveLength(1);
    expect(code.match(/(?<![0-9A-Za-z_.$])10n(?![0-9A-Za-z_.])/g)).toHaveLength(1);
    /* ... and neither digit string appears anywhere as a plain number, which
       is the shape a percent or a cap would arrive in. */
    expect(code.match(/(?<![0-9A-Za-z_.$])100(?![0-9A-Za-z_.n])/g)).toBeNull();
    expect(code.match(/(?<![0-9A-Za-z_.$])10(?![0-9A-Za-z_.n])/g)).toBeNull();
    /* Every numeric literal in the pricer, on one allowlist with its reason:
         0, 1, 2, 3   arithmetic, and the dealt-in bracket boundaries. These
                      are the SETTLER's own branch points - `v_dealt < 2`,
                      `v_dealt <= 2`, `v_dealt = 3` - and not economics: the
                      settings table has no scope for them, it has a NAME per
                      bracket, so a bracket cannot be a row
         2n, 10n,
         100n         the exact-decimal arithmetic above
         15           the significant digits a published answer may carry
         2147483647   the int4 ceiling every Diamond amount is held to */
    const allowed = new Set(['0', '1', '2', '3', '2n', '10n', '100n', '15', '2147483647']);
    /* Strings and regular expressions are not numbers: the decimal-notation
       validator spells a digit range as [1-9], and a settings NAME is a
       string. Both are removed before the scan so the law is about numeric
       literals and not about the alphabet. */
    const numbersOnly = code
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/\/(?:[^/\\\n]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, '/RE/');
    for (const literal of numbersOnly.match(
      /(?<![0-9A-Za-z_.$])[0-9][0-9_]*n?(?![0-9A-Za-z_.])/g
    ) ?? []) {
      expect(allowed.has(literal), `unexplained numeric literal ${literal} in ${PRICER}`).toBe(
        true
      );
    }
  });

  it('reads the settings table, and never the chip schedule or the table columns', () => {
    const code = ts(PRICER) + '\n' + ts(READER);
    expect(ts(READER)).toContain("from('ca_diamond_economics')");
    for (const chip of [
      'RAKE_SPEC',
      'rakeSpec',
      'ca_rake_tier',
      'getRakeConfig',
      'getFullRakeConfig',
      'calculateRake',
      'rake_cap_bb',
      'bbj_percent',
      'getPlayerCountCaps',
    ]) {
      expect(code, `the Diamond pricer reads ${chip}`).not.toContain(chip);
    }
    /* The chip TABLE COLUMN `rake_percent`, which is a different name from
       the setting `cash_rake_percent` and must never be the one read. */
    expect(code, 'the Diamond pricer reads the chip rake_percent column').not.toMatch(
      /(?<!cash_)\brake_percent\b/
    );
  });

  it('prices the Diamond hand from the schedule and the chip hand from the ladder', () => {
    /* ONE BRANCH, and the chip path on the other side of it. The Diamond arm
       must not reach `calculateRake` and the chip arm must not reach the
       pricer, or the two economies would be sharing a number. */
    const code = ts(CONTROLLER);
    expect(code).toContain('const diamondSchedule = this.config.diamondRakeSchedule;');
    const branch = code.slice(
      code.indexOf('const diamondSchedule = this.config.diamondRakeSchedule;'),
      code.indexOf('const rake = calculateRake(')
    );
    expect(branch).toContain('priceDiamondCashRake(');
    expect(branch).not.toContain('calculateRake(');
    expect(branch).not.toContain('rakeConfig');
    /* And the chip arm is still exactly the call it always was. */
    expect(code).toContain(
      'const rake = calculateRake(pot, flopCounts, this.config.rakeConfig, playerCount);'
    );
  });

  it('re-prices the accepted hand rather than trusting the number it is handed', () => {
    const code = ts(BOUNDARY);
    expect(code).toContain('priceDiamondCashRake(');
    expect(code).toContain('diamond_cash_rake_disagrees');
    /* A rake must still be whole and non-negative, and a hand with no
       published schedule may still declare nothing but zero. */
    expect(code).toContain('diamond_whole_rake_required');
    expect(code).toMatch(/input\.rake !== 0/);
    /* The whole-amount rule it always had is still there. */
    expect(code).toContain('diamond_whole_amount_required');
  });

  it('leaves no is_horse filter anywhere on the engine rake path (CLAUDE.md 10.5)', () => {
    for (const path of [PRICER, READER]) {
      expect(ts(path), `${path} filters horses`).not.toMatch(/is_horse|horses?_only|isHorse/i);
    }
    /* The pricer's inputs cannot express the distinction: a pot, a count and
       a flop fact, and no seat, user or identity of any kind. */
    expect(ts(PRICER)).toMatch(/export interface DiamondCashRakeFactsForPricing \{[^}]*\}/);
    const facts = ts(PRICER).match(/export interface DiamondCashRakeFactsForPricing \{([^}]*)\}/);
    expect(facts).not.toBeNull();
    expect(facts![1]).not.toMatch(/user|seat|player|horse|id\b/i);
  });

  it('is a fix and not a repair loop on the engine side either (CLAUDE.md 10.11)', () => {
    const code = ts(PRICER) + '\n' + ts(READER);
    for (const loop of ['setInterval', 'setTimeout', 'cron', 'reconcile', 'backfill', 'repair']) {
      expect(code, `${loop} appears on the Diamond rake path`).not.toMatch(new RegExp(loop, 'i'));
    }
  });

  it('caches nothing across hands: the schedule is read at the deal and frozen', () => {
    /* THE INVALIDATION STORY, as a law. There is no module-level cache, no
       time-to-live and no refresh interval, because each is a window in which
       a hand could be priced on a number the owner had already changed. The
       read happens once per hand, before the hand number is allocated, and
       the snapshot dies with the hand. */
    const reader = ts(READER);
    expect(reader).not.toMatch(/\b(cache|Cache|ttl|TTL|expires?At|staleAfter)\b/);
    const dealing = ts('server/src/engine/ServerTableEngineDealing.ts');
    const call = dealing.indexOf('readDiamondCashRakeSchedule(');
    expect(call).toBeGreaterThan(-1);
    /* Read BEFORE the hand number is allocated, so a failed read costs no
       hand number and deals no cards. The allocation meant is dealHand's own
       - the one that sets this.handCount - not the speculative one taken
       under the between-hands rest. */
    const allocation = dealing.indexOf(
      'this.handCount = this.takePreparedHandNumber() ?? (await this.allocateGlobalHandNumber());'
    );
    expect(allocation).toBeGreaterThan(-1);
    expect(call).toBeLessThan(allocation);
    /* And a failed read deals nothing at all. */
    const guarded = dealing.slice(call, call + 900);
    expect(guarded).toContain('return;');
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
