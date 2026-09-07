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
 * `ai_horses` (migration 20260907221341_horse_identity_is_not_readable_by_a_player).
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

const CLOSER = '20260907221341_horse_identity_is_not_readable_by_a_player.sql';

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

describe('LAW: the SECURITY DEFINER RPCs do not walk around the revoke', () => {
  /* A SECURITY DEFINER function runs as its OWNER, so it reads is_horse
     regardless of what a browser role may SELECT — and then hands it to
     whoever called it. Measured as a PLAIN club member before the mask:
     ca_club_members returned 200 rows with 200 flagged, ca_club_top_players
     100 of 100. Both gate on `ca_can_view_club`, which any member passes. */
  const MASK = '20260907221350_horse_flag_is_masked_for_non_staff_rpcs.sql';

  it('the masking migration exists', () => {
    expect(files, `${MASK} is missing — the RPC bypass is open again`).toContain(MASK);
  });

  it('every flag-returning RPC consults the staff predicate', () => {
    const sql = read(MASK);
    for (const rpc of ['ca_club_members', 'ca_club_top_players', 'fn_club_cashier_members_v2']) {
      expect(sql, `${rpc} must mask the flag`).toContain(rpc);
    }
    expect(sql).toContain('fn_can_see_horse_flag');
    // and it asserts its own effect rather than describing it
    expect(sql).toMatch(/only % of 3 flag-returning RPCs consult the mask/);
  });

  it('the staff predicate is club leadership, not every role with a title', () => {
    /* manager / agent / sub_agent / super_agent are ordinary human users and
       there are many of them. Dan's rule is that a HUMAN USER cannot know. */
    const sql = read(MASK);
    expect(sql).toMatch(/'owner','co_owner','admin'/);
    for (const role of ['manager', 'super_agent', 'sub_agent']) {
      expect(
        sql.match(new RegExp(`cm\\.role IN \\([^)]*'${role}'`)),
        `${role} must not be able to see the flag`
      ).toBeNull();
    }
  });

  it('masks rather than removing, so no caller breaks', () => {
    // Uniform `false` for non-staff. A NULL on some rows and a value on
    // others would itself be the signal.
    expect(read(MASK)).toMatch(/v_may_see AND coalesce\(pr\.is_horse, false\)/);
  });
});

describe('LAW: realtime does not broadcast the answer', () => {
  /* The third door, and the one column grants cannot close: a publication
     carries whatever columns it lists, and Realtime hands that payload to any
     subscriber RLS allows. The client already subscribes to profiles
     postgres_changes for avatars and cosmetics. */
  const RT = '20260907221359_realtime_does_not_broadcast_horse_identity.sql';

  it('the realtime migration exists', () => {
    expect(files, `${RT} is missing — realtime broadcasts horse identity again`).toContain(RT);
  });

  it('withholds exactly the horse columns and keeps the rest', () => {
    const sql = read(RT);
    expect(sql).toMatch(/NOT IN \('is_horse', 'horse_status', 'horse_profile'\)/);
    expect(sql).toMatch(/attname <> 'horse_id'/);
    /* The rest must still publish, or every avatar and cosmetic update on the
       platform silently stops arriving. */
    expect(sql).toMatch(/the list is too narrow/);
  });

  it('does not use SET TABLE, which would unsubscribe every other table', () => {
    const sql = read(RT).replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/ALTER PUBLICATION\s+\S+\s+SET TABLE/i);
    expect(sql).toMatch(/DROP TABLE public\.profiles/);
    expect(sql).toMatch(/ADD TABLE public\.profiles/);
  });
});

describe('LAW: exactly one god account', () => {
  const GOD = '20260907221408_only_one_god_account.sql';

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
    /* The migration must pin ONE address, by e-mail, and use that same
       address everywhere it decides: the pre-flight that proves the keeper
       already holds the role, the demotion's exclusion, and the post-flight
       that proves who is left. The literal itself is not written here -
       tests/a-script-never-wears-a-persons-face pins that Dan's personal
       address appears in no test or script, and this one does not need it:
       what matters is that the three decisions agree on a single account. */
    const named = sql.match(/lower\(u\.email\)\s*=\s*'([^']+@[^']+)'/);
    expect(named, 'the pre-flight names the keeper by e-mail').not.toBeNull();
    const keeper = named![1];
    expect(sql).toContain(`lower(u.email) <> '${keeper}'`);
    expect(sql).toContain(`IF v_email <> '${keeper}' THEN`);
    expect(sql.match(/'[^'\s]+@[^'\s]+\.[a-z]+'/g)?.every((lit) => lit === `'${keeper}'`)).toBe(
      true
    );
    // If that address is not already a god, the migration must not demote anyone.
    expect(sql).toMatch(/refusing to demote anyone/);
  });
});
