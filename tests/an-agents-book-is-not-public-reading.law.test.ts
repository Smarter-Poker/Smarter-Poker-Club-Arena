/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN AGENT'S BOOK IS NOT PUBLIC READING (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The last item phase 7 left open, closed.
 *
 * `fn_agent_unsettled_commission(p_club_id, p_user_id)` was SECURITY DEFINER,
 * granted EXECUTE to `authenticated`, and carried NO authorization check at all.
 * Any logged-in user could pass any other user's id and any club id and be told
 * exactly what that club still owed that person. RLS on `agent_commissions` is
 * correct and would have refused the same read - an agent reads their own rows,
 * a union overseer reads the clubs they oversee - and the definer function
 * walked straight past it.
 *
 * Phase 7 recorded it open rather than fixing it, because the obvious fix
 * (restrict to auth.uid()) breaks `fn_club_set_member_role`: the role-change
 * path calls it to report what the club owes the person whose role is changing,
 * and that person is by definition not the caller.
 *
 * THE FIX IS THE SPLIT, NOT THE RESTRICTION. Two different reads wore one
 * function, so they were separated:
 *
 *   - the CALLER'S OWN read stays in the RPC and gets the guard;
 *   - the OFFICER'S read moves inline into fn_club_set_member_role, which is
 *     itself SECURITY DEFINER and has already authorized its actor through
 *     fn_club_grantable_roles before it gets there. It does not need a second,
 *     weaker door to walk through, and now the report CANNOT regress on the
 *     guard, because it no longer depends on it.
 *
 * Verified against production inside transactions that were rolled back:
 *   service_role 434.95 | self 434.95 | club owner 434.95 |
 *   unrelated user refused 42501 | logged out refused 42501 | null club 22023 |
 *   role change reports 123.45 against a ledger holding 123.45.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260902011456_an_agents_book_is_not_public_reading.sql'
  ),
  'utf8'
);
const SERVICE = fs.readFileSync(
  path.join(process.cwd(), 'src/services/CommissionService.ts'),
  'utf8'
);
const DASHBOARD = fs.readFileSync(
  path.join(process.cwd(), 'src/components/agent/AgentCommissionDashboard.tsx'),
  'utf8'
);
const SWEEP = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260902013900_two_more_definers_that_answered_anybody.sql'
  ),
  'utf8'
);

describe('the read is guarded', () => {
  it('the RPC asks the predicate before it answers', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_agent_unsettled_commission/);
    expect(MIGRATION).toMatch(
      /IF NOT public\.fn_agent_may_read_commission\(p_club_id, p_user_id\) THEN/
    );
  });

  it('and refuses rather than returning a zero', () => {
    // A zero is indistinguishable from "owes nothing". Refusing says which.
    expect(MIGRATION).toMatch(/USING ERRCODE = '42501'/);
    expect(MIGRATION).not.toMatch(/RETURN 0;\s*--\s*not authorized/i);
  });

  it('a null argument is refused too, not treated as a wildcard', () => {
    expect(MIGRATION).toMatch(/IF p_club_id IS NULL OR p_user_id IS NULL THEN/);
    expect(MIGRATION).toMatch(/USING ERRCODE = '22023'/);
  });
});

describe('one definition of who may look', () => {
  it('the predicate exists on its own', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_agent_may_read_commission/);
  });

  it('and admits exactly four kinds of caller', () => {
    expect(MIGRATION).toMatch(/IF public\.fn_is_service_context\(\) THEN\s*\n\s*RETURN true;/);
    expect(MIGRATION).toMatch(/IF v_uid = p_user_id THEN\s*\n\s*RETURN true;/);
    expect(MIGRATION).toMatch(/fn_has_club_role\(v_uid, p_club_id, 'admin'\)/);
    expect(MIGRATION).toMatch(
      /RETURN public\.fn_is_agent_ancestor\(v_uid, p_user_id, p_club_id\);/
    );
  });

  it('a logged-out caller reads nothing', () => {
    expect(MIGRATION).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RETURN false;/);
  });
});

describe('the role-change report cannot regress on the guard', () => {
  it('fn_club_set_member_role is patched, never re-emitted', () => {
    // It is 19 KB and several agents ship into it. Re-emitting from a stale
    // copy is how work gets lost.
    expect(MIGRATION).toMatch(/DO \$patch\$/);
    expect(MIGRATION).toMatch(/IF v_hits <> 1 THEN/);
    // The patch's own CREATE OR REPLACE takes the signature as %s, read back
    // from pg_get_function_arguments. A LITERAL parameter list would mean the
    // body was pasted in from a working copy, which is the failure mode.
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_club_set_member_role\(%s\) RETURNS jsonb/
    );
    expect(MIGRATION).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_club_set_member_role\s*\(\s*\n?\s*p_/
    );
  });

  it('and the patch keeps the parameter defaults', () => {
    // pg_get_function_IDENTITY_arguments strips DEFAULTs, and this function has
    // four, so CREATE OR REPLACE fed the identity form dies with 42P13,
    // "cannot remove parameter defaults from existing function". Caught by
    // rehearsing the migration inside a transaction that was rolled back.
    expect(MIGRATION).toMatch(/pg_get_function_arguments\(p\.oid\)/);
    expect(MIGRATION).not.toMatch(/pg_get_function_identity_arguments\(p\.oid\)\s*\n\s*INTO v_src/);
  });

  it('it reads the ledger inline, with the same partial index', () => {
    expect(MIGRATION).toMatch(/SELECT COALESCE\(SUM\(ac\.amount\), 0\)::numeric INTO v_commission/);
    expect(MIGRATION).toMatch(/agent_commissions_unsettled_idx/);
  });

  it('and the inserted comment does not name the RPC', () => {
    // The assertion proves the call is gone by searching the source for the
    // name; a comment naming it is indistinguishable from a call. Phase 7 hit
    // this exact trap patching this exact function.
    const inserted = MIGRATION.slice(
      MIGRATION.indexOf('v_new :='),
      MIGRATION.indexOf("AND ac.settled_at IS NULL;'")
    );
    expect(inserted).not.toMatch(/fn_agent_unsettled_commission/);
  });

  it('and the migration asserts the call really went', () => {
    expect(MIGRATION).toMatch(
      /RAISE EXCEPTION 'fn_club_set_member_role still names the guarded RPC'/
    );
  });
});

describe('grants are written down, not inherited', () => {
  it.each(['fn_agent_unsettled_commission', 'fn_agent_may_read_commission'])(
    '%s revokes anon and PUBLIC and grants the two roles that need it',
    (fn) => {
      expect(MIGRATION).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid, uuid\\) FROM PUBLIC;`)
      );
      expect(MIGRATION).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid, uuid\\) FROM anon;`)
      );
      expect(MIGRATION).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid, uuid\\) TO authenticated;`)
      );
      expect(MIGRATION).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid, uuid\\) TO service_role;`)
      );
    }
  );

  it('and the migration refuses to apply if anon kept EXECUTE', () => {
    expect(MIGRATION).toMatch(
      /RAISE EXCEPTION 'anon can still execute fn_agent_unsettled_commission'/
    );
  });
});

describe('the two other definers that answered anybody stay shut', () => {
  // Found by sweeping for the SHAPE of this hole. Neither had a caller that
  // needed `authenticated`, so neither got a guard - they got the grant taken
  // away, which is smaller and cannot be got wrong.
  it.each([
    ['sum_agent_volume', 'uuid, uuid, timestamptz'],
    ['fn_club_rakeback_margin_violations', 'uuid'],
  ])('%s is revoked from authenticated and anon', (fn, args) => {
    expect(SWEEP).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${args}\\) FROM authenticated;`)
    );
    expect(SWEEP).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${args}\\) FROM anon;`)
    );
  });

  it('and kept for the service role, which is what actually calls them', () => {
    // agent-analytics.js reaches sum_agent_volume through getSupabase().
    // Revoking service_role too would break that route.
    expect(SWEEP).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.sum_agent_volume\(uuid, uuid, timestamptz\) TO service_role;/
    );
    expect(SWEEP).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_club_rakeback_margin_violations\(uuid\) TO service_role;/
    );
    expect(SWEEP).toMatch(/service_role lost EXECUTE on sum_agent_volume/);
  });

  it('and the migration refuses to apply if either grant survived', () => {
    expect(SWEEP).toMatch(/authenticated can still execute sum_agent_volume/);
    expect(SWEEP).toMatch(/authenticated can still execute fn_club_rakeback_margin_violations/);
  });

  it('a REVOKE-only migration fires no schema-cache reload, and says so', () => {
    // GRANT/REVOKE are not in pgrst_ddl_watch's list. CLAUDE.md Production DDL
    // policy, rule 5. Nothing here may grow a CREATE/ALTER without moving.
    expect(SWEEP).not.toMatch(/\b(CREATE|ALTER)\s+(TABLE|INDEX|TYPE|TRIGGER|PUBLICATION)\b/i);
    expect(SWEEP).toMatch(/does NOT fire pgrst_ddl_watch/);
  });
});

describe('the client only ever asks about itself', () => {
  it('unsettledCommission takes the caller id and passes it straight through', () => {
    expect(SERVICE).toMatch(/async unsettledCommission\(clubId: string, userId: string\)/);
    expect(SERVICE).toMatch(/p_user_id: userId,/);
  });

  it('and a refusal surfaces rather than reading as zero owed', () => {
    // `if (error) throw error` - the caller reports it. Swallowing it into 0
    // would put "you are owed nothing" on the screen of someone who is owed.
    const fn = SERVICE.slice(
      SERVICE.indexOf('async unsettledCommission'),
      SERVICE.indexOf('async downlineCommission')
    );
    expect(fn).toMatch(/if \(error\) throw error;/);
  });

  it('the dashboard nulls the figure on failure rather than showing zero', () => {
    expect(DASHBOARD).toMatch(
      /reportError\(e, 'AgentCommissionDashboard\.unsettled'\);\s*\n\s*if \(current\(\)\) setOwed\(null\);/
    );
  });

  it('a failed downline read says Unavailable, never zero', () => {
    // The catch used to leave downlineOwed empty, and every sub agent card then
    // rendered 0 - "the club owes this downline nothing" - indistinguishable
    // from the truth. null means "could not read", 0 means "owes nothing".
    expect(DASHBOARD).toMatch(/totalCommission: number \| null;/);
    expect(DASHBOARD).toMatch(/let downlineFailed = false;/);
    expect(DASHBOARD).toMatch(/downlineFailed = true;/);
    expect(DASHBOARD).toMatch(
      /totalCommission: downlineFailed \? null : \(downlineOwed\[a\.id\] \?\? null\),/
    );
    expect(DASHBOARD).toMatch(/\? 'Unavailable'/);
    // `|| 0` would turn a genuine zero and a failure back into the same thing.
    expect(DASHBOARD).not.toMatch(/totalCommission: downlineOwed\[a\.id\] \|\| 0/);
  });

  it('and a failed summary says so instead of rendering a blank tab', () => {
    // The panel is gated on `summary &&`, which is right: four zero cards on a
    // failed read are indistinguishable from "you earned nothing". But the
    // gate used to render nothing at all - a blank tab, no explanation, no way
    // back.
    expect(DASHBOARD).toMatch(/activeTab === 'summary' && !summary && \(/);
    expect(DASHBOARD).toMatch(/Your Commission Summary Could Not Be Loaded\./);
    expect(DASHBOARD).toMatch(/onClick=\{\(\) => loadDataRef\.current\(\)\}/);
  });
});
