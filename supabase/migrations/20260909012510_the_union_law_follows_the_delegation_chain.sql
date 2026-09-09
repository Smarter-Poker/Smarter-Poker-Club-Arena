-- 20260909012510_the_union_law_follows_the_delegation_chain.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A LAW THAT CHECKS A LOCATION BREAKS WHEN THE CODE MOVES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_union_law_selftest` raised a CRITICAL financial alert at 00:20 UTC on
-- 2026-09-09 with one breach: `tournament_buyin_rake_not_club_scoped`.
--
-- THE LAW IS NOT BREACHED. The tournament buy-in rake is still club-scoped on
-- both paths. What moved is where the code lives. The check read:
--
--     WHERE n.nspname='public' AND p.proname=r.fn
--       AND p.prosrc LIKE '%rake_records%'
--       AND p.prosrc LIKE '%fn_tournament_entry_split%'
--
-- - it demanded the two markers in the ENTRY POINT's own body. The maintenance
-- freeze and the atomic lifecycle work since wrapped both entry points in gates,
-- so the entry points are now thin delegators and the split lives further down:
--
--   fn_register_for_tournament (68 chars, an overload shim)
--     -> fn_register_for_tournament(uuid, boolean)                  320 chars
--       -> ..._before_maintenance_announcement_gate                1,716 chars
--         -> ..._before_atomic_lifecycle_gate                        770 chars
--           -> ..._before_atomic_capacity_20260907   10,993 chars  <- BOTH MARKERS
--
--   fn_register_horse_for_tournament                                301 chars
--     -> ..._before_maintenance_gate                 6,963 chars   <- BOTH MARKERS
--
-- So the alert was a false positive, and a false positive on a money law is
-- expensive twice over: it costs somebody an investigation, and it teaches the
-- next reader to discount the alarm. CLAUDE.md 10.84 is about exactly this - a
-- check nobody can trust is not a check.
--
-- THE FIX: follow the delegation instead of assuming the location. The check now
-- walks, from each entry point, every function in that entry point's own name
-- family that the body actually names, to a depth of eight, and asserts the two
-- markers appear SOMEWHERE reachable. It survives another gate being wrapped
-- around the entry point, which is the thing that keeps happening, and it still
-- fails if the split is genuinely removed.
--
-- PROVED BOTH WAYS BEFORE SHIPPING, read-only against production:
--   positive: law_reachable = true for both entry points
--             (chain sizes 4 and 2, so both terminate)
--   negative: substituting a marker that does not exist makes BOTH false, so
--             the new predicate is not simply always-true - which is the failure
--             mode that matters for a self-test.
--
-- HOW THIS EDITS THE LAW. fn_union_law_selftest carries seventeen checks.
-- Retyping it to change one risks silently dropping another, so this reads the
-- live definition, does a literal replace of the single stale block, and refuses
-- to proceed if that block is not found or if the replacement does not land.
-- That is the pattern 20260828041248_the_union_law_check_follows_the_money.sql
-- established for this exact function.
--
-- ROLLBACK
--   Swap the new block back for the old one below; both are quoted in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old CONSTANT text :=
'IF EXISTS (SELECT 1 FROM (VALUES (''fn_register_for_tournament''),(''fn_register_horse_for_tournament'')) AS r(fn)
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                 WHERE n.nspname=''public'' AND p.proname=r.fn
                                   AND p.prosrc LIKE ''%rake_records%''
                                   AND p.prosrc LIKE ''%fn_tournament_entry_split%'')) THEN';
  v_repl CONSTANT text :=
'IF EXISTS (SELECT 1 FROM (VALUES (''fn_register_for_tournament''),(''fn_register_horse_for_tournament'')) AS r(fn)
              WHERE NOT EXISTS (
                WITH RECURSIVE chain(proname, prosrc, depth) AS (
                  SELECT p.proname, p.prosrc, 0
                    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname=''public'' AND p.proname=r.fn
                  UNION
                  SELECT p2.proname, p2.prosrc, c.depth+1
                    FROM chain c
                    JOIN pg_proc p2 ON p2.proname LIKE r.fn || ''%''
                                   AND position(''public.''||p2.proname||''('' in c.prosrc) > 0
                    JOIN pg_namespace n2 ON n2.oid=p2.pronamespace AND n2.nspname=''public''
                   WHERE c.depth < 8
                )
                SELECT 1 FROM chain
                 WHERE prosrc LIKE ''%rake_records%''
                   AND prosrc LIKE ''%fn_tournament_entry_split%'')) THEN';
BEGIN
  v_src := pg_get_functiondef('public.fn_union_law_selftest()'::regprocedure);

  IF position(v_old in v_src) = 0 THEN
    RAISE EXCEPTION
      'the tournament_buyin_rake_not_club_scoped block is not in the live definition in the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old, v_repl);

  IF position('WITH RECURSIVE chain(proname, prosrc, depth)' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  -- Every other check must survive the edit. These are the landmarks of the
  -- sixteen this migration does not touch.
  IF position('atomic_distribute_rake_law_missing' in v_new) = 0
     OR position('fn_resolve_bbj_pool_law_missing' in v_new) = 0
     OR position('record_rake_delegation_missing' in v_new) = 0
     OR position('tournament_buyin_rake_not_club_scoped' in v_new) = 0 THEN
    RAISE EXCEPTION 'a check went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- Grants restated, unchanged. The self-test is readable by an authenticated
-- union overseer or platform admin, and it asks who is calling in its own first
-- statement (fn_caller_is_engine / fn_is_platform_admin / fn_is_union_overseer),
-- so it authorises rather than assuming.
REVOKE ALL ON FUNCTION public.fn_union_law_selftest() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_law_selftest() TO service_role, authenticated;

COMMIT;
