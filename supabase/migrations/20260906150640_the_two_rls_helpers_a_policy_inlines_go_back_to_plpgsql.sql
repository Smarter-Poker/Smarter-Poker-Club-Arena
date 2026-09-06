-- ═══════════════════════════════════════════════════════════════════════════
--  THE TWO RLS HELPERS A POLICY INLINES GO BACK TO PL/pgSQL
--  A forward fix for a change I made twenty minutes earlier, in 20260906150328.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED. `the_realtime_poller_decodes_only_what_someone_reads`
-- converted six RLS helper functions from PL/pgSQL to LANGUAGE sql, to take
-- them off the nested-PL/pgSQL path that trips plpgsql_check's pldbgapi2
-- statement stack inside `realtime.apply_rls`. For the four SECURITY DEFINER
-- helpers that is a clear win and they stay converted. For the two INVOKER
-- ones it was a change I could not justify, so they go back.
--
-- Dropping `SET search_path` from an invoker SQL function makes it INLINABLE:
-- Postgres can pull the body bodily into the RLS policy that calls it, which
-- changes the plan of every row-level check on `tables`, `tournaments` and
-- anything else whose policy names it. That is not a micro-optimisation to
-- make casually on the hottest path in the database.
--
-- BEING ACCURATE ABOUT THE EVIDENCE, because the first version of this header
-- was not. I reverted these on the strength of a 15-second WAL probe in which
-- `tables` rose from 28.40 to 42.88 ms per change, and a prepare+execute loop
-- that read 1.15 ms before and 20.86 ms after. Both were taken under live
-- load, minutes apart, and neither is a controlled comparison.
--
-- The plan, which IS decisive, says the inlining never happened and the cost
-- is not where I claimed:
--
--     Index Scan using tables_pkey on tables (actual rows=1)
--       Filter: (NOT COALESCE(is_private,false)) OR (club_id IS NULL)
--               OR is_club_member(club_id, ...) OR EXISTS(SubPlan 3)
--               OR fn_union_oversees_club(club_id, ...)
--       ... every later branch: (never executed)
--     Planning Time:  2.236 ms
--     Execution Time: 0.134 ms
--
-- `is_club_member` appears as a CALL in the filter, not inlined; the policy
-- short-circuits on the first branch; execution is 0.134 ms. The real
-- per-change cost of a `tables` change is PLANNING - 2.2 ms of it - which
-- apply_rls pays in full on every change, because it DEALLOCATEs and re-
-- PREPAREs `walrus_rls_stmt` per change per role. Nothing about the helper's
-- language changes that.
--
-- SO WHY KEEP THE REVERT. Because the conservative form is the right one here
-- regardless of which reading of the numbers is correct: this is the form that
-- ran at production for months, it is provably not inlinable, and it removes a
-- degree of freedom from the hottest path in the database in exchange for
-- nothing measurable. The four functions that carry a real, measured benefit
-- keep it.
--
-- THE RULE THIS LEAVES BEHIND, and the one worth remembering: a function an
-- RLS policy calls must not be made inlinable without measuring that policy
-- afterwards - and "measuring" means the plan, not a timing loop taken against
-- a live database whose load moves underneath you.
--
-- ROLLBACK: re-apply the two CREATE OR REPLACE statements from 20260906150328.

CREATE OR REPLACE FUNCTION public.is_club_member(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM club_members
        WHERE club_id = p_club_id
        AND user_id = p_user_id
        AND status = 'active'
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM clubs WHERE id = p_club_id AND owner_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM club_members
        WHERE club_id = p_club_id
        AND user_id = p_user_id
        AND role IN ('owner', 'co_owner', 'admin')
        AND status = 'active'
    );
END;
$function$;

DO $$
DECLARE v_bad int;
BEGIN
  -- The two invoker helpers must be back on PL/pgSQL and must carry a SET
  -- clause, which is what makes them opaque to the planner.
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname IN ('is_club_member','is_club_admin')
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_user_id uuid'
     AND (l.lanname <> 'plpgsql' OR p.proconfig IS NULL OR p.prosecdef);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'post-check: % invoker RLS helper(s) are still inlinable', v_bad;
  END IF;

  -- The four definer helpers stay on SQL.
  SELECT count(*) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_is_union_overseer','fn_union_oversees_club',
                       'fn_club_is_in_downline','fn_club_cashier_can_transact')
     AND l.lanname = 'sql' AND p.prosecdef;
  IF v_bad <> 4 THEN
    RAISE EXCEPTION 'post-check: expected 4 SECURITY DEFINER helpers on LANGUAGE sql, found %', v_bad;
  END IF;
END $$;
