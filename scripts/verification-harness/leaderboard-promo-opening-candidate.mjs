// UNQUALIFIED disposable-only source proposal. Never executes SQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const openingPredecessor = new URL(
  '../../supabase/migrations/20260923143157_the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl.sql',
  import.meta.url
);
export function buildPromoOpeningCandidate(source) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '2cdd4a18c315290da99012c98dc244996db4de4799ffa738d11a5c82a3b88840'
  );
  const header = 'CREATE FUNCTION public.fn_complete_club_opening_setup(';
  assert.equal(source.split(header).length, 2);
  let sql = header + source.split(header)[1].split('\n$function$;')[0] + '\n$function$;';
  function once(old, next) {
    assert.equal(sql.split(old).length, 2);
    sql = sql.replace(old, () => next);
  }
  once(header, 'CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup(');
  // Preserve completed historical setup replay. Refuse new overlay requests
  // after actual owner authorization AND replay, before any allocation.
  once(
    '  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN',
    `  IF COALESCE(p_leaderboard_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN`
  );
  once(
    'promo_balance = COALESCE(promo_balance, 0) + v_promo_budget,',
    'promo_balance = COALESCE(promo_balance, 0) + v_promo_budget + v_leaderboard_budget,'
  );
  once('    v_leaderboard_budget,\n    p_operation_id', '    0,\n    p_operation_id');
  once(
    '      v_leaderboard_budget, v_leaderboard_budget, v_actor',
    '      v_leaderboard_budget, v_promo_after, v_actor'
  );
  const commentStart = sql.indexOf(
    '  -- THE SEED IS WRITTEN, AND HELD, BEFORE THE PROGRAM IT FUNDS'
  );
  const commentEnd = sql.indexOf('  INSERT INTO public.club_opening_setups', commentStart);
  assert.ok(commentStart > 0 && commentEnd > commentStart);
  once(
    sql.slice(commentStart, commentEnd),
    '  -- New prize allocation is held in actual Promo; no new opening seed.\n'
  );
  once(
    `  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the seeded budget, and carries the
  -- owner's explicit answer on the Club Bank overlay (OFF unless chosen).`,
    `  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the new actual Promo allocation.
  -- New Club Bank overlays are refused before allocations.`
  );
  const signature =
    'public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)';
  return `-- UNQUALIFIED proposal; no installed migration version.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
    OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('${signature}')
    AND md5(p.prosrc)='578960fee3c325b9c724e976bed968f4'
    AND md5(pg_get_functiondef(p.oid))='2c731edde57e2ec7d867108a3caf64fb'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact opening setup predecessor drift';
  END IF;
END $guard$;
${sql}
-- Existing owner and execute ACL retained by CREATE OR REPLACE.
COMMIT;
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildPromoOpeningCandidate(readFileSync(openingPredecessor, 'utf8')));
  } catch {
    console.error('Unqualified Promo opening candidate refused: reviewed input changed');
    process.exitCode = 1;
  }
}
