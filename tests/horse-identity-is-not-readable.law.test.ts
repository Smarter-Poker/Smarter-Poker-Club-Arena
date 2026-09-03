/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A PLAYER CANNOT ASK THE DATABASE WHO IS A HORSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE OR
 * USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * `a-horse-is-indistinguishable-from-a-human` pins that OUR CODE does not ask.
 * This pins the half that actually matters, because a player is not limited to
 * our code — they can open a console and write their own query. Measured as an
 * ordinary non-staff logged-in player before the fix:
 *
 *     profiles.is_horse = true     1000 rows   the entire roster
 *     profiles.horse_profile       1308 rows   and the playing style
 *     ai_horses                     100 rows   readable LOGGED OUT
 *
 * The close is a column-level REVOKE on `profiles` plus a deny-all policy on
 * `ai_horses` (migration 20260902_horse_identity_is_not_readable_by_a_player).
 *
 * WHY THIS TEST IS SOURCE-LEVEL RATHER THAN A LIVE QUERY: the unit suite has no
 * database. What it CAN guarantee is that the migration which closes the hole
 * is present, says what it does, and is never quietly reverted by a later
 * "restore client read grants" pass — which is exactly how the grant got there
 * in the first place (see 20260822150000_profiles_restore_client_read_grants).
 * The live behaviour was verified by probe at apply time and the numbers are
 * recorded in the migration header.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

const CLOSER = '20260902_horse_identity_is_not_readable_by_a_player.sql';

describe('LAW: the horse-identity columns are not granted to a browser', () => {
  it('the closing migration exists', () => {
    expect(files, `${CLOSER} is missing — the leak is open again`).toContain(CLOSER);
  });

  it('revokes all three identity columns from both browser roles', () => {
    const sql = read(CLOSER);
    for (const role of ['authenticated', 'anon']) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE SELECT \\(is_horse, horse_profile, horse_status\\) ON public\\.profiles FROM ${role}`
        )
      );
    }
  });

  it('closes the logged-out ai_horses policy', () => {
    const sql = read(CLOSER);
    expect(sql).toContain('DROP POLICY IF EXISTS "Anyone can view horses" ON public.ai_horses');
    expect(sql).toContain('CREATE POLICY deny_all_ai_horses');
  });

  it('asserts its own effect rather than describing it', () => {
    /* The first attempt at this migration revoked a column on `table_seats`,
       where a TABLE-level grant makes that a no-op — and its own post-apply
       assertion caught the lie and rolled the whole thing back. A migration
       that only says what it fixes cannot fail when it does not. */
    const sql = read(CLOSER);
    expect(sql).toContain('POST-APPLY');
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});

describe('LAW: no later migration re-opens it', () => {
  /* This is the real failure mode. The grant existed because a 2026-08-22
     migration called "restore_client_read_grants" handed `authenticated` 102
     columns of `profiles`, and a future pass with the same good intention
     would hand back these three without noticing. */
  const laterThanCloser = files.filter((f) => f > CLOSER && f.endsWith('.sql'));

  it('nothing after the close re-grants the horse columns on profiles', () => {
    const offenders = laterThanCloser.filter((f) => {
      const sql = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');
      if (!/GRANT\s+SELECT[^;]*ON\s+public\.profiles/i.test(sql)) return false;
      return /\bis_horse\b|\bhorse_profile\b|\bhorse_status\b/i.test(sql);
    });

    expect(
      offenders,
      'a later migration grants a horse-identity column back to a browser role'
    ).toEqual([]);
  });

  it('nothing after the close re-opens ai_horses to anon or authenticated', () => {
    const offenders = laterThanCloser.filter((f) => {
      const sql = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*--.*$/gm, '');
      return /CREATE\s+POLICY[^;]*ON\s+public\.ai_horses[^;]*USING\s*\(\s*true\s*\)/i.test(sql);
    });
    expect(offenders, 'a later migration makes ai_horses world-readable again').toEqual([]);
  });
});

describe('LAW: exactly one god account', () => {
  const GOD = '20260902_only_one_god_account.sql';

  it('the migration exists and enforces uniqueness in the database', () => {
    expect(files).toContain(GOD);
    const sql = read(GOD);
    /* Demoting one row fixes today. The partial unique index is what makes a
       second god impossible tomorrow, from any client or any agent. */
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS one_god_account_only/);
    expect(sql).toMatch(/WHERE role = 'god'/);
  });

  it('names the one account that keeps it, and refuses to guess', () => {
    const sql = read(GOD);
    expect(sql).toContain('daniel@bekavactrading.com');
    // If that address is not already a god, the migration must not demote anyone.
    expect(sql).toMatch(/refusing to demote anyone/);
  });
});
