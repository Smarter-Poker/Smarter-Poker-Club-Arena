/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE GATE THAT STOPS THE NEXT UNAUTHORISED DEFINER WRITER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * scripts/ci/check-definer-authorization.mjs blocks a migration that declares a
 * SECURITY DEFINER function which writes, which a browser role can execute, and
 * which never consults auth.uid(), auth.role() or auth.jwt().
 *
 * Nineteen such functions were live on 2026-08-27. One let an ordinary member
 * rewrite a club's member_count from 592 to 10591. Another pays chips. Eighteen
 * were revoked, and the nineteenth was written the same afternoon by an author
 * who had no way to know the rule existed.
 *
 * A gate nobody has watched fail is a gate nobody knows works. These feed the
 * checker the exact shapes that shipped, including the revoke trap that made an
 * earlier fix a silent no-op, and assert on its VERDICT rather than on its
 * wording, so rephrasing the help text cannot quietly disarm it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

type Verdict = (sql: string, allowlist?: Set<string>, grantSql?: string) => string[];
let unauthorisedWriters: Verdict;
let anonReadableDefiners: Verdict;
let unrevokedClones: Verdict;
let unscopedRosterDefiners: Verdict;
let clonedFunctions: (sql: string) => string[];
let stripComments: (sql: string) => string;
let effectiveGrants: (
  sql: string,
  name: string
) => { public: boolean; anon: boolean; authenticated: boolean };

beforeAll(async () => {
  // Computed specifier: the checker is a plain ESM script with no type
  // declarations, and a static import would be a resolution error. The path is
  // built from __dirname rather than import.meta.url because the test
  // environment serves modules over http, which the ESM loader will not take.
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-definer-authorization.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  unauthorisedWriters = mod.unauthorisedWriters;
  anonReadableDefiners = mod.anonReadableDefiners;
  unrevokedClones = mod.unrevokedClones;
  unscopedRosterDefiners = mod.unscopedRosterDefiners;
  clonedFunctions = mod.clonedFunctions;
  effectiveGrants = mod.effectiveGrants;
  stripComments = mod.stripComments;
});

/** The shape that shipped nineteen times: no GRANT written at all, which
 *  leaves the Postgres default of EXECUTE to PUBLIC. */
const OPEN_WRITER = `
CREATE OR REPLACE FUNCTION public.increment_member_count(p_club_id uuid, p_delta integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN UPDATE clubs SET member_count = COALESCE(member_count, 0) + p_delta WHERE id = p_club_id; END;
$function$;
`;

describe('SQL comment boundaries cannot erase or invent authorization', () => {
  const revoke =
    'REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC, anon, authenticated;';

  it.each([
    "SELECT 'an unfinished /* comment';",
    'SELECT "an unfinished /* comment";',
    'SELECT $payload${"old":"BEGIN\\n /* unfinished","new":"-- data"}$payload$;',
    "SELECT 'it''s -- data /*';",
    String.raw`SELECT E'it\'s -- data /*';`,
  ])('keeps a real revoke after quoted comment markers: %s', (payload) => {
    const sql = `${payload}\n${OPEN_WRITER}\n${revoke}\n/* a later migration comment */`;
    expect(stripComments(sql)).toContain(revoke);
    expect(unauthorisedWriters(OPEN_WRITER, new Set(), sql)).toEqual([]);
    expect(anonReadableDefiners(OPEN_WRITER, new Set(), sql)).toEqual([]);
    expect(
      unauthorisedWriters(
        OPEN_WRITER,
        new Set(),
        `${sql}\nGRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO authenticated;`
      )
    ).toEqual(['increment_member_count']);
  });

  it('strips nested real comments, including authorization claims in function bodies', () => {
    const sql = OPEN_WRITER.replace(
      'BEGIN UPDATE',
      'BEGIN /* outer /* inner */ auth.uid() */ UPDATE'
    );
    expect(unauthorisedWriters(sql)).toEqual(['increment_member_count']);
    expect(unauthorisedWriters(`${sql}\n/* outer /* inner */ ${revoke} */`)).toEqual([
      'increment_member_count',
    ]);
  });

  it.each(["'", '"', '$example$'])(
    'does not accept a quoted %s revoke as an ACL change',
    (quote) => {
      expect(unauthorisedWriters(`${OPEN_WRITER}\nSELECT ${quote}${revoke}${quote};`)).toEqual([
        'increment_member_count',
      ]);
    }
  );

  it('reads real ACL statements in a DO body without trusting quoted examples', () => {
    expect(unauthorisedWriters(`${OPEN_WRITER}\nDO $acl$ BEGIN ${revoke} END $acl$;`)).toEqual([]);
    expect(
      unauthorisedWriters(`${OPEN_WRITER}\nDO $acl$ BEGIN RAISE NOTICE '${revoke}'; END $acl$;`)
    ).toEqual(['increment_member_count']);
  });

  it('continues treating dynamic write and grant strings conservatively', () => {
    const dynamic = OPEN_WRITER.replace(
      /BEGIN UPDATE[\s\S]*?END;/,
      "BEGIN EXECUTE 'UPDATE clubs SET member_count = 0'; END;"
    );
    expect(unauthorisedWriters(dynamic)).toEqual(['increment_member_count']);
    expect(
      unauthorisedWriters(
        `${dynamic}\n${revoke}\nDO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO authenticated;'; END $$;`
      )
    ).toEqual(['increment_member_count']);
  });

  it('keeps the recorded-format ACL in the actual combined migration payload', () => {
    const migration = (name: string) =>
      readFileSync(resolve(__dirname, '..', 'supabase/migrations', name), 'utf8');
    const payload = migration('20260917061000_mtt_dual_capacity_admission_preparation.sql');
    const declaration = migration(
      '20260917064000_mtt_recorded_format_seat_consumers_preparation.sql'
    );
    const later = migration(
      '20260917233447_tournament_original_funding_and_obligation_receipts.sql'
    );
    const combined = [payload, declaration, later].join('\n');
    expect(anonReadableDefiners(declaration, new Set(), combined)).toEqual([]);
    const missingRevoke = combined.replace(
      /REVOKE ALL ON FUNCTION public\.fn_ca_tournament_recorded_seat_first\([^;]+;/,
      ''
    );
    expect(missingRevoke).not.toEqual(combined);
    expect(anonReadableDefiners(declaration, new Set(), missingRevoke)).toEqual([
      'fn_ca_tournament_recorded_seat_first',
    ]);
  });
});

describe('the checker catches the shape that shipped', () => {
  it('applies a multi-function revoke to every signature, including multi-argument functions', () => {
    const sql = `REVOKE ALL ON FUNCTION public.first(uuid,text), public.second(), public.third(text,uuid,numeric) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.first(uuid,text), public.second(), public.third(text,uuid,numeric) TO service_role;`;
    for (const name of ['first', 'second', 'third']) {
      expect(effectiveGrants(sql, name)).toEqual({
        public: false,
        anon: false,
        authenticated: false,
      });
    }
    expect(effectiveGrants(sql, 'unmentioned')).toEqual({
      public: true,
      anon: true,
      authenticated: true,
    });
  });

  it('detects a reopened second function and reads only recipient roles, not schema qualifiers', () => {
    const sql = `REVOKE ALL ON FUNCTION public.first(), public.second(uuid,text) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.first(), public.second(uuid,text) TO authenticated;`;
    expect(effectiveGrants(sql, 'second')).toEqual({
      public: false,
      anon: false,
      authenticated: true,
    });
    const onlyAnon = `REVOKE EXECUTE ON FUNCTION public.first(), public.second(uuid,text) FROM anon;`;
    expect(effectiveGrants(onlyAnon, 'first')).toEqual({
      public: true,
      anon: false,
      authenticated: true,
    });
  });

  it('flags a DEFINER writer with no grant statement at all', () => {
    // Silence is not safety. Postgres grants EXECUTE to PUBLIC by default and
    // every browser role inherits it, which is how most of the nineteen got there.
    expect(unauthorisedWriters(OPEN_WRITER)).toEqual(['increment_member_count']);
  });

  it('clears it once it is revoked from PUBLIC, anon and authenticated', () => {
    const fixed =
      OPEN_WRITER +
      `
REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO service_role;
`;
    expect(unauthorisedWriters(fixed)).toEqual([]);
  });

  it('still flags it when only PUBLIC is revoked and authenticated keeps a grant', () => {
    /**
     * THE TRAP. On 2026-08-27 a column-level REVOKE was shipped against a
     * table-level grant and changed nothing, and has_column_privilege still
     * answered true afterwards. Same mistake, different privilege: revoking
     * one role while another still holds an explicit grant reads as a fix and
     * does nothing. The checker models roles separately so it cannot be fooled
     * the way a reviewer can.
     */
    const halfFixed =
      OPEN_WRITER +
      `
REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_member_count(uuid, integer) TO authenticated;
`;
    expect(unauthorisedWriters(halfFixed)).toEqual(['increment_member_count']);
  });

  it('models the live Supabase role-specific defaults before any explicit grant', () => {
    const publicOnly =
      OPEN_WRITER +
      `
REVOKE ALL ON FUNCTION public.increment_member_count(uuid, integer) FROM PUBLIC;
`;

    expect(effectiveGrants(publicOnly, 'increment_member_count')).toEqual({
      public: false,
      anon: true,
      authenticated: true,
    });
    expect(unauthorisedWriters(publicOnly)).toEqual(['increment_member_count']);
  });
});

describe('the checker does not cry wolf', () => {
  it('accepts a writer that derives its actor from the request', () => {
    const guarded = `
CREATE OR REPLACE FUNCTION public.fn_save_thing(p_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN UPDATE things SET value = p_value WHERE owner_id = auth.uid(); END;
$function$;
`;
    expect(unauthorisedWriters(guarded)).toEqual([]);
  });

  it('is not satisfied by a comment that merely names auth.uid()', () => {
    // A body that talks about the check without making it is the failure mode
    // this whole class is made of.
    const pretend = `
CREATE OR REPLACE FUNCTION public.fn_pretend(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  -- authorisation is handled by auth.uid() upstream
  UPDATE things SET touched = now() WHERE id = p_id;
END;
$function$;
`;
    expect(unauthorisedWriters(pretend)).toEqual(['fn_pretend']);
  });

  it('ignores trigger functions, which cannot be invoked as an RPC', () => {
    const trg = `
CREATE OR REPLACE FUNCTION public.trg_touch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN INSERT INTO audit(at) VALUES (now()); RETURN NEW; END;
$function$;
`;
    expect(unauthorisedWriters(trg)).toEqual([]);
  });

  it('ignores a DEFINER function that only reads', () => {
    const ro = `
CREATE OR REPLACE FUNCTION public.fn_read_thing(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN RETURN (SELECT to_jsonb(t) FROM things t WHERE t.id = p_id); END;
$function$;
`;
    expect(unauthorisedWriters(ro)).toEqual([]);
  });

  it('honours the allowlist', () => {
    expect(unauthorisedWriters(OPEN_WRITER, new Set(['increment_member_count']))).toEqual([]);
  });
});

describe('the allowlist stays small and reasoned', () => {
  const allow = JSON.parse(
    readFileSync(
      resolve(__dirname, '..', 'scripts/ci/definer-authorization.allowlist.json'),
      'utf8'
    )
  );

  it('holds only the one function still exposed, read line by line', () => {
    // get_current_settlement_period left on 2026-09-22: no browser role can
    // execute either overload, so its exception was forgiving nothing.
    expect(Object.keys(allow.reviewedExceptions).sort()).toEqual(['recalculate_leaderboard_ranks']);
  });

  it('gives every entry a reason long enough to be a reason', () => {
    for (const [name, why] of Object.entries(allow.reviewedExceptions)) {
      expect(typeof why, name).toBe('string');
      expect((why as string).length, name).toBeGreaterThan(120);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RULE 2: READ-ONLY IS NOT THE SAME AS HARMLESS (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The writer rule above only ever looks at functions that WRITE. In one
 * afternoon THREE new SECURITY DEFINER functions arrived anon-executable and it
 * cleared every one of them, because none wrote a row:
 *
 *   fn_tournament_metrics    operator dashboard numbers
 *   fn_truly_unused_indexes  table names, index names, sizes, scan counts
 *   fn_nit_evictions         who was evicted from which table, and when
 *
 * The middle one returns the schema's table and index names to a caller with no
 * account, and index names on this project encode their columns. That is a
 * partial column map, free, to anybody who asks.
 *
 * These feed the checker the exact shapes — including the revoke trap, which is
 * MORE dangerous for this rule than for the writer one, because `anon` inherits
 * whatever PUBLIC holds: `REVOKE ... FROM anon` alone changes nothing at all.
 */
describe('a new definer that answers a caller with no account', () => {
  const fn = (name: string, extra = '', body = 'SELECT 1;', ret = 'TABLE(x int)') =>
    `CREATE OR REPLACE FUNCTION public.${name}(p int) RETURNS ${ret}\n` +
    `LANGUAGE sql SECURITY DEFINER AS $$ ${body} $$;\n${extra}`;

  it('fails when the migration writes no GRANT at all — the shape all three shipped as', () => {
    expect(anonReadableDefiners(fn('fn_truly_unused_indexes'))).toEqual([
      'fn_truly_unused_indexes',
    ]);
  });

  it('fails a revoke from anon alone, because anon inherits PUBLIC', () => {
    const sql = fn('fn_leaky', 'REVOKE ALL ON FUNCTION public.fn_leaky(int) FROM anon;');
    expect(anonReadableDefiners(sql)).toEqual(['fn_leaky']);
  });

  it('passes once PUBLIC, anon and authenticated are all named', () => {
    const sql = fn(
      'fn_closed',
      'REVOKE ALL ON FUNCTION public.fn_closed(int) FROM PUBLIC, anon, authenticated;\n' +
        'GRANT EXECUTE ON FUNCTION public.fn_closed(int) TO service_role;'
    );
    expect(anonReadableDefiners(sql)).toEqual([]);
  });

  it('still sees the live anon default after a PUBLIC-only revoke', () => {
    const sql = fn(
      'fn_default_acl_leak',
      'REVOKE ALL ON FUNCTION public.fn_default_acl_leak(int) FROM PUBLIC;\n' +
        'GRANT EXECUTE ON FUNCTION public.fn_default_acl_leak(int) TO service_role;'
    );
    expect(anonReadableDefiners(sql)).toEqual(['fn_default_acl_leak']);
  });

  it('passes a read kept for logged-in players: this rule guards the pre-login roles only', () => {
    const sql = fn(
      'fn_player_read',
      'REVOKE ALL ON FUNCTION public.fn_player_read(int) FROM PUBLIC, anon;\n' +
        'GRANT EXECUTE ON FUNCTION public.fn_player_read(int) TO authenticated;'
    );
    expect(anonReadableDefiners(sql)).toEqual([]);
  });

  it('passes a function that asks who is calling', () => {
    expect(anonReadableDefiners(fn('fn_asks', '', 'SELECT auth.uid();'))).toEqual([]);
  });

  it('passes a trigger function, which cannot be reached as an RPC', () => {
    expect(anonReadableDefiners(fn('fn_trg', '', 'BEGIN RETURN NEW; END;', 'trigger'))).toEqual([]);
  });

  it('passes deliberate public surface once somebody writes down why', () => {
    const sql = fn('fn_global_leaderboard_period');
    expect(anonReadableDefiners(sql)).toEqual(['fn_global_leaderboard_period']);
    expect(anonReadableDefiners(sql, new Set(['fn_global_leaderboard_period']))).toEqual([]);
  });

  it('does not fire on a migration that only revokes — the fix must not fail its own gate', () => {
    const sql =
      'REVOKE ALL ON FUNCTION public.fn_truly_unused_indexes(integer) FROM PUBLIC, anon, authenticated;';
    expect(anonReadableDefiners(sql)).toEqual([]);
  });

  /**
   * A branch's migrations are APPLIED AS A UNIT, so a REVOKE in a sibling
   * migration really does close the function. Reading one file in isolation
   * reported a hole that would never exist — and the first thing it reported
   * that way was fn_definer_exposure_audit, the security audit itself, whose
   * REVOKE lives in the very next migration of the same branch.
   */
  it('sees a REVOKE that lands in a sibling migration of the same branch', () => {
    const declaring = fn('fn_audit_thing');
    const sibling =
      'REVOKE ALL ON FUNCTION public.fn_audit_thing(int) FROM PUBLIC, anon, authenticated;\n' +
      'GRANT EXECUTE ON FUNCTION public.fn_audit_thing(int) TO service_role;';

    // On its own the declaring file looks wide open, and honestly so.
    expect(anonReadableDefiners(declaring)).toEqual(['fn_audit_thing']);
    // Read against the whole branch, it is closed.
    expect(anonReadableDefiners(declaring, new Set(), `${declaring}\n${sibling}`)).toEqual([]);
  });

  it('applies the same branch-wide reading to the writer rule', () => {
    // A function whose body merely NAMES the write verbs - which is what the
    // exposure audit's own detection regex does - still reads as a writer, on
    // purpose: EXECUTE 'insert into ...' is a real write and must not become a
    // blind spot. The branch's REVOKE is what clears it.
    const declaring = fn(
      'fn_names_the_verbs',
      '',
      "SELECT 1 WHERE 'x' ~ '(insert into|update |delete from)';"
    );
    expect(unauthorisedWriters(declaring)).toEqual(['fn_names_the_verbs']);

    const sibling =
      'REVOKE ALL ON FUNCTION public.fn_names_the_verbs(int) FROM PUBLIC, anon, authenticated;';
    expect(unauthorisedWriters(declaring, new Set(), `${declaring}\n${sibling}`)).toEqual([]);
  });

  it('starts with an empty anonPublicSurface, so the first entry costs a decision', () => {
    const allow = JSON.parse(
      readFileSync(
        resolve(__dirname, '..', 'scripts/ci/definer-authorization.allowlist.json'),
        'utf8'
      )
    );
    // Not "must stay empty" — it must stay REASONED. Every entry needs a
    // paragraph saying what an unauthenticated caller may learn from it.
    for (const [name, why] of Object.entries(allow.anonPublicSurface ?? {})) {
      expect(typeof why, name).toBe('string');
      expect((why as string).length, name).toBeGreaterThan(120);
    }
  });
});

describe('the gate is actually wired to something', () => {
  it('runs in CI as a blocking step', () => {
    const ci = readFileSync(resolve(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node scripts/ci/check-definer-authorization.mjs');
    expect(ci).toContain('Definer Authorization');
  });

  it('runs on pre-push, because branch protection is unavailable on a private repo', () => {
    const hook = readFileSync(resolve(__dirname, '..', '.husky/pre-push'), 'utf8');
    expect(hook).toContain('check-definer-authorization.mjs');
  });
});

/**
 * ---------------------------------------------------------------------------
 *  A CLONE IS A DECLARATION (2026-09-01)
 * ---------------------------------------------------------------------------
 *
 * 20260901090000_club_card_human_realtime_stats.sql duplicated three functions
 * under new names by rewriting pg_get_functiondef output and EXECUTEing it.
 * Two of the three were revoked from PUBLIC, anon and authenticated in that
 * same file; the third was not, and CREATE FUNCTION grants EXECUTE to PUBLIC.
 *
 * fn_seat_club_for_user_membership_unchecked therefore went live SECURITY
 * DEFINER, owned by postgres, answering a caller with no account: give it a
 * user id and a table id and it returns which club that player is seated under
 * and which clubs they are a member of. The gate cleared the migration,
 * because a clone is not spelled CREATE FUNCTION and there was nothing to
 * judge. The daily live audit found it hours later.
 *
 * These cases are fed the REAL migration, so they fail if the reading of a
 * clone is ever weakened back to "only what CREATE FUNCTION declares".
 */
describe('a function cloned into a new name is judged like a new function', () => {
  const SHIPPED = resolve(
    __dirname,
    '..',
    'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'
  );

  it('tells the clone target from the function being copied', () => {
    // The source half of the regexp_replace is a REGULAR EXPRESSION, so its dot
    // and paren are escaped; what actually separates source from target is that
    // the source is the argument to pg_get_functiondef.
    const clones = clonedFunctions(readFileSync(SHIPPED, 'utf8')).sort();
    expect(clones).toEqual([
      'fn_create_club_atomic_membership_impl',
      'fn_join_club_membership_impl',
      'fn_seat_club_for_user_membership_unchecked',
    ]);
  });

  it('names the one clone that migration left open, and only that one', () => {
    expect(unrevokedClones(readFileSync(SHIPPED, 'utf8'))).toEqual([
      'fn_seat_club_for_user_membership_unchecked',
    ]);
  });

  it('clears it once the revoke it was missing is present', () => {
    const sql = readFileSync(SHIPPED, 'utf8');
    const withRevoke =
      sql +
      '\nREVOKE ALL ON FUNCTION public.fn_seat_club_for_user_membership_unchecked' +
      '(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;';
    expect(unrevokedClones(sql, new Set(), withRevoke)).toEqual([]);
  });

  it('is not satisfied by revoking authenticated while PUBLIC still holds it', () => {
    const sql = readFileSync(SHIPPED, 'utf8');
    const halfFixed =
      sql +
      '\nREVOKE ALL ON FUNCTION public.fn_seat_club_for_user_membership_unchecked' +
      '(uuid, uuid, uuid) FROM authenticated;';
    expect(unrevokedClones(sql, new Set(), halfFixed)).toEqual([
      'fn_seat_club_for_user_membership_unchecked',
    ]);
  });

  it('has no auth.uid() exemption, because the body is not in the file', () => {
    // The two rules above clear a function whose body consults the request.
    // A clone's body lives in the database, so there is nothing to read and
    // nothing to earn: the grants have to be stated.
    const sql = `
DO $clone$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.fn_original(uuid)'::regprocedure) INTO v_def;
  v_def := regexp_replace(v_def, 'FUNCTION public\\.fn_original\\(',
    'FUNCTION public.fn_copy(', 1, 1);
  EXECUTE v_def;   -- auth.uid() appears here and means nothing
END;
$clone$;
`;
    expect(unrevokedClones(sql)).toEqual(['fn_copy']);
  });

  it('accepts a written decision instead, like the other two rules', () => {
    const sql = readFileSync(SHIPPED, 'utf8');
    expect(unrevokedClones(sql, new Set(['fn_seat_club_for_user_membership_unchecked']))).toEqual(
      []
    );
  });
});

describe('a grant statement cannot be read across a semicolon', () => {
  /**
   * Found while writing the clone rule. The gap between GRANT/REVOKE and
   * `ON FUNCTION` was `[\s\S]*?`, so the word "grant" anywhere at all -- here
   * inside a RAISE EXCEPTION message, which is how the real migration ends --
   * reached forward to the next `ON FUNCTION` in the file and stamped its own
   * verb on somebody else's statement.
   *
   * In that direction it read as stricter than the truth. Reversed, a stray
   * "revoke" ahead of a real GRANT clears a function that is wide open, which
   * is the exact failure this file exists to prevent.
   */
  it('does not let a stray verb in a string relabel the next statement', () => {
    const sql = `
CREATE OR REPLACE FUNCTION public.fn_reader(p_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'this club still has a duplicate owner-wallet grant';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_reader(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reader(uuid) TO service_role;
`;
    expect(anonReadableDefiners(sql)).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RULE 4: A ROSTER NOBODY CAN BE SCOPED OUT OF (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `fn_bbj_unclaimed_shares()` shipped on 2026-09-06 returning EVERY unpaid
 * bad-beat-jackpot share on the platform - player id, arena name, amount, table,
 * hand, reason - SECURITY DEFINER, with no REVOKE and no GRANT, so Postgres's
 * default handed EXECUTE to PUBLIC and every logged-in account inherited it.
 *
 * It fell exactly between the rules above. It is a READ, so rule 1 (writers)
 * never judged it. It is reachable by `authenticated` rather than `anon`, so
 * rule 2 never judged it either. The live audit caught it fourteen minutes
 * later, which is a net doing its job AFTER the fact.
 *
 * THE DANGEROUS DIRECTION FOR THIS RULE IS CRYING WOLF. Widening rule 2 to
 * `authenticated` would fail the very many read-only functions a logged-in
 * player is legitimately allowed to call, and would train everybody to stuff the
 * allowlist - the harm rule 2's own header warns about. So the pins below are
 * mostly about what it must NOT flag: an argument list, a scalar return, a body
 * that asks who is calling, a revoke in the same branch. Only all four
 * conditions together describe an operator console with no way of knowing who
 * asked.
 */
describe('a roster nobody can be scoped out of', () => {
  /** The shape that shipped: no arguments, returns a table, no grant written. */
  const SHIPPED = `
CREATE OR REPLACE FUNCTION public.fn_bbj_unclaimed_shares()
RETURNS TABLE(user_id uuid, arena_name text, amount numeric, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT u.user_id, p.arena_name, u.amount, u.reason
  FROM bbj_unclaimed_shares u JOIN profiles p ON p.id = u.user_id
  WHERE u.paid_at IS NULL;
$function$;
`;

  it('names the function that shipped, in the shape it shipped in', () => {
    expect(unscopedRosterDefiners(SHIPPED)).toEqual(['fn_bbj_unclaimed_shares']);
  });

  it('clears it once the migration that closes it is read alongside', () => {
    // The real fix, 20260906153953. PUBLIC is named as well as the two browser
    // roles, because revoking a role while PUBLIC still holds EXECUTE reads as
    // a fix and does nothing.
    const closed =
      SHIPPED +
      '\nREVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM PUBLIC, anon, authenticated;' +
      '\nGRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO service_role;';
    expect(unscopedRosterDefiners(closed)).toEqual([]);
  });

  it('is not satisfied by revoking the browser roles while PUBLIC still holds it', () => {
    const halfFixed =
      SHIPPED +
      '\nREVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM anon, authenticated;';
    expect(unscopedRosterDefiners(halfFixed)).toEqual(['fn_bbj_unclaimed_shares']);
  });

  it('passes a roster the function scopes to its caller itself', () => {
    // Option 2 of the remedy: a player seeing their OWN parked share. The
    // function knows who asked, so it is not this rule's shape at all.
    const scoped = SHIPPED.replace('WHERE u.paid_at IS NULL', 'WHERE u.user_id = auth.uid()');
    expect(unscopedRosterDefiners(scoped)).toEqual([]);
  });

  it('passes a function that takes an argument, because an argument can be scoped', () => {
    // This is the pin that stops the rule becoming "rule 2 for authenticated".
    // A parameterised read is the ordinary shape of a legitimate logged-in
    // query and failing those would train everybody to stuff the allowlist.
    const withArg = SHIPPED.replace(
      'fn_bbj_unclaimed_shares()',
      'fn_bbj_unclaimed_shares(p_club_id uuid)'
    );
    expect(unscopedRosterDefiners(withArg)).toEqual([]);
  });

  it('passes a parameterless definer that returns a scalar', () => {
    // A count, a flag, a name-availability check. It answers one question; it
    // does not hand back a list of people.
    const scalar = `
CREATE OR REPLACE FUNCTION public.fn_bbj_unclaimed_total()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER
AS $function$ SELECT COALESCE(SUM(amount), 0) FROM bbj_unclaimed_shares; $function$;
`;
    expect(unscopedRosterDefiners(scalar)).toEqual([]);
  });

  it('catches the SETOF form as well as TABLE(', () => {
    // RETURNS SETOF composite is the same disclosure written differently, and a
    // rule that only knew one spelling would be a rule anyone could step around
    // by accident.
    const setof = `
CREATE OR REPLACE FUNCTION public.fn_unpaid_roster()
RETURNS SETOF public.bbj_unclaimed_shares
LANGUAGE sql STABLE SECURITY DEFINER
AS $function$ SELECT * FROM bbj_unclaimed_shares WHERE paid_at IS NULL; $function$;
`;
    expect(unscopedRosterDefiners(setof)).toEqual(['fn_unpaid_roster']);
  });

  it('passes SECURITY INVOKER, which RLS still applies to', () => {
    // The whole premise of every rule in this file is that DEFINER bypasses
    // RLS. An INVOKER function is judged by the caller's own policies.
    const invoker = SHIPPED.replace('SECURITY DEFINER', 'SECURITY INVOKER');
    expect(unscopedRosterDefiners(invoker)).toEqual([]);
  });

  it('accepts a written decision, like the three rules above it', () => {
    // A genuinely public list - a leaderboard, a lobby - is allowed, once
    // somebody writes down why every row in it is safe for anyone to read.
    expect(unscopedRosterDefiners(SHIPPED, new Set(['fn_bbj_unclaimed_shares']))).toEqual([]);
  });
});
