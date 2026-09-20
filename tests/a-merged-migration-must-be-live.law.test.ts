/**
 * ===========================================================================
 *  LAW: A MIGRATION THAT MERGED MUST BE LIVE
 * ===========================================================================
 *
 * Two checks already watch migrations and neither asks this.
 * `check-migrations-applied.mjs` asks only of the migrations a PULL REQUEST
 * adds, only about the OBJECTS they declare, and only against a nightly
 * snapshot - once a branch merges nothing asks again.
 * `check-applied-migrations-are-recorded.mjs` asks the opposite direction:
 * what production applied that the repo has no file for.
 *
 * So a migration could merge to main, never be applied, and look shipped:
 * merged, green, closed. Measured 2026-09-19 across the 202 migrations merged
 * in the preceding seven days, THREE had never reached the database:
 *
 *   20260913172658 a_player_can_see_their_own_responsible_gaming_state
 *     fn_rg_require_not_excluded is not SECURITY DEFINER, so it read
 *     responsible_gaming_limits with the caller's privileges. With no policy
 *     admitting the user the row is about, the player's own row was invisible
 *     to the player and the function's "no row means no limits" branch turned
 *     that invisibility into permission: a self-excluded player asking about
 *     themselves was told ok: true. Six days.
 *   20260918121836 anon_executes_only_what_it_needs
 *     Thirteen anon grants the repository described as gone were still live.
 *   20260919025445 early_bird_original_fee_custody_after_player_finality
 *     27 fees still held in escrow.
 *
 * Two of the three are player protection or money.
 *
 * WHY THE CHECK IS THREE STEPS AND NOT ONE. Supabase's apply transport stamps
 * its own version and agents submit a condensed blob, so a migration is
 * routinely recorded under a different version and sometimes a different NAME.
 * On that sweep, matching by name alone produced ten candidates of which SEVEN
 * were false. A check that accuses at a 70% false rate gets switched off,
 * which is how this estate already lost `Applied Migrations Are Recorded`.
 *
 * AND WHY STEP 3 EXISTS, which is the part worth reading. An eighth candidate
 * was classified unapplied BY HAND, by reading the settlement function for the
 * wrong lock mode: the edit produces `FOR KEY SHARE`, and counting `FOR SHARE`
 * and `FOR NO KEY UPDATE` said the opposite of the truth. What corrected it
 * was the migration's own assertion, which refused on apply with "has 0
 * cash-lease lock sites, expected exactly 1". A migration knows what it did
 * precisely enough to be machine-checked; a person reading it later does not.
 * So a file that creates no object states its own proof:
 *
 *     -- @live-proof: <a boolean SQL expression>
 *
 * This law pins that the check decides by evidence in that order, that it
 * never passes when it cannot ask, and - the part that keeps it true - that
 * from 2026-09-20 onward no migration may be written that nothing can check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// The law parses a migration with the CHECK's own functions, never a lookalike
// regex of its own: a guard that disagrees with the thing it guards is worse
// than no guard.
import { declaredObjects, declaredProofs, code } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CHECK = 'scripts/ci/check-migrations-are-live.mjs';
/** The two checks that ask different questions: the negative control. */
const PR_ONLY = 'scripts/ci/check-migrations-applied.mjs';
const OPPOSITE = 'scripts/ci/check-applied-migrations-are-recorded.mjs';
/** The workflow that has to run it, or it is a guard with no reader. */
const READER = '.github/workflows/production-integrity-audit.yml';

/**
 * The convention binds migrations written after it existed. Everything older
 * is reported by the check as unverifiable and fails nothing - 3,000 files
 * cannot be retrofitted, and a rule that fails on history gets switched off.
 */
const BINDS_FROM = '20260920';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read(CHECK);

/** A migration that WAS live and one that was not, both read from the repo. */
const CREATED_AN_OBJECT = '20260913172658_a_player_can_see_their_own_responsible_gaming_state.sql';
const CREATED_NOTHING = '20260918121836_anon_executes_only_what_it_needs.sql';

function migrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('a merged migration must be live', () => {
  it('decides by name, then by live objects, then by a declared proof', () => {
    expect(SRC).toContain('supabase_migrations.schema_migrations');
    // Step 2 reads the LIVE catalogue. A snapshot is what let the existing
    // gate pass a migration the database had never seen.
    expect(SRC).toContain('pg_proc');
    expect(SRC).toContain('pg_policy');
    expect(SRC).toContain('pg_trigger');
    expect(SRC).not.toContain('supabase-schema-manifest.json');
    // Step 3, the convention.
    expect(SRC).toContain('@live-proof');
    // Two verdicts, and only one of them is an accusation.
    expect(SRC).toContain('MERGED BUT NOT LIVE');
    expect(SRC).toContain('unverifiable');
  });

  it('never passes silently when it cannot ask', () => {
    // CLAUDE.md 10.86: no URL, an unreadable catalogue, an empty answer -
    // exit 2, never 0.
    expect(SRC).toContain('COULD NOT ASK');
    expect(SRC).toContain('process.exit(2)');
    expect(SRC).toMatch(/no SUPABASE_DB_URL \/ DATABASE_URL/);
    expect(SRC).toMatch(/schema_migrations returned no names at all/);
    // And it never contains, derives or writes a credential (10.84).
    expect(SRC).toMatch(/process\.env\.SUPABASE_DB_URL \|\| process\.env\.DATABASE_URL/);
    expect(SRC).not.toMatch(/\.env['"\s]/);
  });

  it('a guard must have a reader, and this one is named', () => {
    // CLAUDE.md 10.86 rule 3. The three detectors that asked production a
    // question and were wired to nothing are why that rule exists.
    const reader = read(READER);
    expect(reader).toContain('check-migrations-are-live.mjs');
  });

  it('does not count pg_temp scaffolding as something production should carry', () => {
    // Every ca_patch migration creates pg_temp.ca_patch. If that counted, each
    // of them would be accused of not being live, for ever.
    const objects = declaredObjects(
      'CREATE FUNCTION pg_temp.ca_patch(p_fn text) RETURNS void LANGUAGE plpgsql AS $x$ BEGIN END $x$;\n' +
        'CREATE OR REPLACE FUNCTION public.fn_real_thing(p uuid) RETURNS jsonb LANGUAGE sql AS $y$ SELECT 1 $y$;'
    );
    expect(objects.map((o) => o.name)).toEqual(['public.fn_real_thing']);
  });

  it('reads DDL and not prose: a comment about CREATE TABLE is not a CREATE TABLE', () => {
    const sql = '-- CREATE TABLE public.not_real (id uuid);\nSELECT 1;';
    expect(code(sql)).not.toContain('CREATE TABLE');
    expect(declaredObjects(sql)).toEqual([]);
  });

  it('step 2 is what catches a migration that creates something', () => {
    // The responsible-gaming fix declares a policy, so its absence was
    // decidable from the catalogue with no proof needed.
    const objects = declaredObjects(
      fs.readFileSync(path.join(MIGRATIONS, CREATED_AN_OBJECT), 'utf8')
    );
    expect(objects).toEqual([
      { kind: 'policy', name: 'rg_limits_user_select_own', on: 'public.responsible_gaming_limits' },
    ]);
  });

  it('step 3 is what catches a migration that creates nothing', () => {
    // The anon revoke creates nothing at all: it changes grants. Nothing in
    // any catalogue is named by the file, which is exactly the class that sat
    // merged and unapplied - and the class the proof convention is for.
    const sql = fs.readFileSync(path.join(MIGRATIONS, CREATED_NOTHING), 'utf8');
    expect(declaredObjects(sql)).toEqual([]);
    expect(declaredProofs(sql)).toEqual([]);
  });

  it('a declared proof is read whole, and several may be declared', () => {
    const sql = [
      '-- @live-proof: EXISTS (SELECT 1 FROM pg_policy WHERE polname = $$p$$)',
      'BEGIN;',
      '-- @live-proof:   (SELECT count(*) FROM pg_proc) > 0   ',
      'COMMIT;',
    ].join('\n');
    expect(declaredProofs(sql)).toEqual([
      'EXISTS (SELECT 1 FROM pg_policy WHERE polname = $$p$$)',
      '(SELECT count(*) FROM pg_proc) > 0',
    ]);
  });

  it('the negative control: neither existing check asks this question', () => {
    const prOnly = read(PR_ONLY);
    // It scopes itself to the branch's own diff, which is why a migration that
    // merges unapplied is never asked about again.
    expect(prOnly).toMatch(/baseRef/);
    expect(prOnly).toContain('supabase-schema-manifest.json');
    // The other one asks the opposite direction.
    expect(read(OPPOSITE)).toMatch(/schema_migrations/);
    expect(SRC).not.toEqual(prOnly);
  });

  /**
   * THE ONE THAT MATTERS LATER. A migration that creates nothing and proves
   * nothing cannot be checked by this or by anything else, and that is the
   * exact shape the silent misses had.
   */
  it('every migration written after this law is checkable', () => {
    const offenders: string[] = [];
    for (const file of migrations()) {
      const version = file.slice(0, file.indexOf('_'));
      if (version < BINDS_FROM) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      if (declaredObjects(sql).length > 0) continue;
      if (declaredProofs(sql).length > 0) continue;
      offenders.push(file);
    }
    expect(
      offenders,
      'these migrations create no persistent object and declare no proof, so nothing can ' +
        'tell whether production carries them - which is how three migrations sat merged ' +
        'and unapplied for up to a week, two of them player protection or money. Add a line\n' +
        '    -- @live-proof: <boolean SQL expression>\n' +
        'saying what a reader would run to see the change is there. A migration that ' +
        'creates a function, table, view, index, trigger or policy needs nothing: the ' +
        'check looks those up itself.'
    ).toEqual([]);
  });
});
