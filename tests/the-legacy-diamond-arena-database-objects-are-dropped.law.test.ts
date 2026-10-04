/**
 * LAW - the legacy Diamond Arena database objects are dropped, and stay dropped
 * (docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md Phase 12 line 7; CLAUDE.md 10.11;
 * docs/changelog/2026-10-04-the-legacy-diamond-arena-database-objects-are-dropped.md).
 *
 * Four things went in migration 20261004214251, each read empty or inert in
 * production on 2026-10-04:
 *  - fn_arena_deposit and fn_arena_withdraw, the chip-backed manual arena doors
 *    custody had already reduced to a single RAISE;
 *  - their two names in fn_guard_profile_privileged_columns. This is the pin
 *    that matters. The guard admits a profiles.diamonds write from any call
 *    stack naming a listed function, so a name left on the list after its
 *    function is gone is an admission waiting for whoever creates a function
 *    under it next;
 *  - diamond_arena_events, the retired standalone arena's trivia log (0 rows);
 *  - profiles.diamond_arena_preferences (no row held a value).
 *
 * WHY EACH PIN EXISTS
 *  - the drops carry no CASCADE and no IF EXISTS, so an unread dependent or an
 *    estate that is not the one read aborts the file instead of being swept up;
 *  - the guard is edited in place from its live text under a preimage md5 and
 *    compared byte for byte with the intended postimage, because the guard is
 *    on fn_ca_guard_watchlist() and has been edited by five migrations: a
 *    re-typed body is how an earlier admission gets lost;
 *  - the data assertions run after the locks are taken, so the emptiness that
 *    justifies the drop cannot change between the check and the drop;
 *  - profiles and auth.users are locked together under a 250 ms lock_timeout
 *    and retried, never queued behind (2026-10-01, a DROP that took the auth
 *    schema hostage);
 *  - the register rows and the journal are evidence and are kept;
 *  - no later migration recreates any of the four.
 */
import { describe, expect, it } from 'vitest';
import { latestNamed, migrationFiles, readMigration } from './helpers/migrations';

const { name: MIGRATION, sql: SQL } = latestNamed(
  '_the_legacy_diamond_arena_database_objects_are_dropped.sql'
);
/** The statements, without the header and without comment lines. */
const BODY = SQL.slice(SQL.indexOf('\nBEGIN;\n'))
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const later = migrationFiles().filter((f) => f > MIGRATION);

describe('the four legacy objects are dropped in one guarded transaction', () => {
  it('is one transaction that fails fast on a lock instead of queueing writers', () => {
    expect(BODY.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(BODY.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(BODY).toContain("SET LOCAL lock_timeout = '2s';");
    expect(BODY).toContain("PERFORM set_config('lock_timeout', '250ms', true);");
    expect(BODY).toContain(
      'LOCK TABLE public.profiles, auth.users, public.diamond_arena_events IN ACCESS EXCLUSIVE MODE;'
    );
    expect(BODY).toContain('EXCEPTION WHEN lock_not_available THEN');
  });

  it('drops both doors, the table and the column, with no CASCADE and no IF EXISTS', () => {
    expect(BODY).toContain('DROP FUNCTION public.fn_arena_deposit(integer, text);');
    expect(BODY).toContain('DROP FUNCTION public.fn_arena_withdraw(integer, text);');
    expect(BODY).toContain('DROP TABLE public.diamond_arena_events;');
    expect(BODY).toContain('ALTER TABLE public.profiles DROP COLUMN diamond_arena_preferences;');
    expect(BODY).toContain(
      'REVOKE SELECT (diamond_arena_preferences) ON public.profiles FROM authenticated;'
    );
    expect(BODY).not.toMatch(/\bCASCADE\b/i);
    expect(BODY).not.toMatch(/\bDROP\s+\w+\s+IF\s+EXISTS\b/i);
  });

  it('writes no DROP TRIGGER and no DROP POLICY (they lock the auth schema)', () => {
    expect(BODY).not.toMatch(/\bDROP\s+TRIGGER\b/i);
    expect(BODY).not.toMatch(/\bDROP\s+POLICY\b/i);
  });

  it('takes the locks before it reads the data that must be empty, and drops after', () => {
    const lock = BODY.indexOf('LOCK TABLE public.profiles, auth.users');
    const events = BODY.indexOf('SELECT count(*) INTO v_n FROM public.diamond_arena_events;');
    const prefs = BODY.indexOf(
      "WHERE diamond_arena_preferences IS NOT NULL AND diamond_arena_preferences <> '{}'::jsonb;"
    );
    const drop = BODY.indexOf('ALTER TABLE public.profiles DROP COLUMN');
    expect(lock).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(lock);
    expect(prefs).toBeGreaterThan(events);
    expect(drop).toBeGreaterThan(prefs);
    expect(BODY).toContain('it is dropped only when empty');
    expect(BODY).toContain('it is dropped only when every row is NULL or {}');
  });
});

describe('the wallet guard forgets the two doors and nothing else', () => {
  it('edits the live text under a preimage pin and compares the result byte for byte', () => {
    expect(BODY).toContain("IF md5(v_def) <> 'd40c547c47f3d0516dc24f22ab53da7e' THEN");
    expect(BODY).toContain("v_want := replace(v_def, v_old, '');");
    expect(BODY).toContain("IF md5(v_want) <> 'b140541b68ba8f97ce74d7e0a5e7680f'");
    expect(BODY).toContain('IF v_after IS DISTINCT FROM v_want THEN');
    // The guard is never re-typed: a literal declaration here would be a second
    // copy of a body five migrations have edited.
    expect(BODY).not.toContain('FUNCTION public.fn_guard_profile_privileged_columns(');
  });

  it('removes exactly the two retired-door lines', () => {
    const old = BODY.slice(BODY.indexOf('$old$') + 5, BODY.lastIndexOf('$old$'));
    expect(old).toBe(
      "     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'\n" +
        "     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'\n"
    );
  });

  it('keeps every other admission and the refusal, and declares the redefinition', () => {
    for (const door of [
      'send_stream_gift',
      'fn_poker_diamond_tournament_charge',
      'send_wallet_diamond_transfer',
      'fn_poker_diamond_buyin',
    ])
      expect(BODY).toContain(`position('function (public[.])?${door}[(]' IN v_after) = 0`);
    expect(BODY).toContain("IF position('fn_arena_' IN v_after) > 0");
    expect(BODY).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',"
    );
    expect(BODY).toContain(`'migration ${MIGRATION.replace(/\.sql$/, '')}'`);
  });
});

describe('the two functions that named the column are edited from their live text', () => {
  it('pins each preimage and postimage and refuses a body that still names the column', () => {
    for (const md5 of [
      'd98e1becf64a5c606d310b26b0a1e49c',
      '8cd27b35b801feb60a239bdf1c0c51cd',
      '3e00cb1086da53eac75ba2d34001a75a',
      'b563620364f47288038818f2f0e24ad9',
    ])
      expect(BODY).toContain(`'${md5}'`);
    expect(BODY).toContain("position('diamond_arena_preferences' IN v_want) > 0");
    expect(BODY).toContain('its grants moved');
  });
});

describe('evidence is kept and the arena is not opened', () => {
  it('refuses unless the arena is closed and custody is empty', () => {
    expect(BODY).toContain('WHERE cash_games_enabled OR tournaments_enabled');
    expect(BODY).toContain('IF EXISTS (SELECT 1 FROM public.poker_diamond_custody) THEN');
  });

  it('keeps both register rows as retired and touches no journal', () => {
    expect(BODY).toContain('the register lost a retired arena door row; they are kept as evidence');
    expect(BODY).not.toMatch(/\b(DELETE\s+FROM|UPDATE|INSERT\s+INTO|TRUNCATE)\b/i);
    expect(BODY).not.toContain('diamond_transactions');
  });

  it('declares a live proof for every end state', () => {
    const proofs = [...SQL.matchAll(/^-- @live-proof: (.*)$/gm)].map((m) => m[1]);
    expect(
      proofs.some((p) =>
        p.includes("to_regprocedure('public.fn_arena_deposit(integer,text)') IS NULL")
      )
    ).toBe(true);
    expect(
      proofs.some((p) => p.includes("to_regclass('public.diamond_arena_events') IS NULL"))
    ).toBe(true);
    expect(proofs.some((p) => p.includes("attname = 'diamond_arena_preferences'"))).toBe(true);
    expect(proofs.some((p) => p.includes('b140541b68ba8f97ce74d7e0a5e7680f'))).toBe(true);
  });
});

describe('nothing brings them back', () => {
  it('no later migration recreates a door, the table or the column, or names a door to the guard', () => {
    const offenders: string[] = [];
    for (const f of later) {
      const sql = readMigration(f)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      if (
        /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?fn_arena_(deposit|withdraw)\s*\(/i.test(
          sql
        )
      )
        offenders.push(`${f}: recreates a retired arena door`);
      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(public\.)?diamond_arena_events\b/i.test(sql))
        offenders.push(`${f}: recreates diamond_arena_events`);
      if (/ADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?"?diamond_arena_preferences\b/i.test(sql))
        offenders.push(`${f}: re-adds profiles.diamond_arena_preferences`);
      if (/fn_arena_(deposit|withdraw)\[\(\]/.test(sql))
        offenders.push(`${f}: names a retired arena door to the wallet guard`);
    }
    expect(offenders).toEqual([]);
  });
});
