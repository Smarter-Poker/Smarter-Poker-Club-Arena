-- ═══════════════════════════════════════════════════════════════════════════
--  ONE `SET` CLAUSE WAS COSTING THE DATABASE A QUARTER OF ITSELF
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `get_club_home` is the single largest consumer of database time on this
-- platform. Measured from pg_stat_statements:
--
--     40,670 calls · 2,143.8 ms mean · 87,187 seconds total · 28.0% of ALL
--     database execution time
--
-- Most of that is one predicate. `fn_club_home_in_scope` decides whether a
-- table belongs on a club's home page, and it is called once PER ROW against
-- every live table on the platform - 1,243 rows on the plan below, of which
-- 1,090 are then discarded.
--
-- The function was already the right shape: LANGUAGE sql, IMMUTABLE, PARALLEL
-- SAFE, a single CASE over six scalar arguments, no table access of any kind.
-- Postgres should fold that straight into the calling query as a plain boolean
-- expression and never call it at all.
--
-- IT COULD NOT, BECAUSE OF THE `SET search_path` CLAUSE. A SQL function that
-- carries a SET is not inlinable - the planner must keep it as a real function
-- call so the setting can be established and torn down around each invocation.
-- One line of hardening, added for a reason that does not apply here, turned a
-- free expression into 1,243 function calls per club-home load.
--
-- MEASURED, same query, same rows, read-only, before touching anything:
--
--     with the function call     491.5 ms   (460 ms of it inside the Filter)
--     with the body inlined by hand
--     into the same statement     76.6 ms
--
-- 6.4x, on the predicate that dominates the platform's busiest function.
--
-- WHY DROPPING THE SET IS SAFE HERE, precisely: search_path exists to stop a
-- caller resolving an unqualified name to an object they control. This
-- function references NO objects. Its entire body is `=`, `COALESCE` and
-- `ANY` over its own parameters, all of which resolve from pg_catalog, which
-- is always on the path implicitly and cannot be shadowed. It is also not
-- SECURITY DEFINER, so it runs as the caller and gains no privilege to abuse.
-- Do NOT copy this reasoning to a function that reads a table: there the SET
-- is load-bearing and the call overhead is the price of safety.
--
-- The cost declaration comes down with it. 100 is the default for a function
-- the planner must call; an inlined expression should be costed like one, and
-- leaving it at 100 makes the planner avoid a predicate that is now free.
--
-- ROLLBACK:
--   CREATE OR REPLACE FUNCTION public.fn_club_home_in_scope(
--     p_club_id uuid, p_is_private boolean, p_union_id uuid,
--     p_viewer_union_id uuid, p_viewer_club_id uuid, p_viewer_union_club_ids uuid[])
--   RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
--   SET search_path TO 'public'
--   AS $f$ ... same body ... $f$;

CREATE OR REPLACE FUNCTION public.fn_club_home_in_scope(
  p_club_id uuid,
  p_is_private boolean,
  p_union_id uuid,
  p_viewer_union_id uuid,
  p_viewer_club_id uuid,
  p_viewer_union_club_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
COST 1
AS $function$
  SELECT CASE
    WHEN p_viewer_union_id IS NOT NULL THEN
      (p_union_id = p_viewer_union_id
       OR (p_club_id = p_viewer_club_id AND COALESCE(p_is_private, false)))
    ELSE p_club_id = ANY (p_viewer_union_club_ids)
  END;
$function$;

DO $$
DECLARE v_src text; v_cost real; v_vol "char";
BEGIN
  SELECT pg_get_functiondef(p.oid), p.procost, p.provolatile
    INTO v_src, v_cost, v_vol
    FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_club_home_in_scope';

  -- The whole point: a SET clause blocks inlining.
  IF position('SET search_path' in v_src) > 0 THEN
    RAISE EXCEPTION 'the SET clause is still there, so the function still cannot be inlined';
  END IF;
  IF v_vol <> 'i' THEN
    RAISE EXCEPTION 'function must stay IMMUTABLE to be inlinable, got %', v_vol;
  END IF;
  IF v_cost > 1 THEN
    RAISE EXCEPTION 'cost is still %, the planner will avoid a predicate that is now free', v_cost;
  END IF;

  -- And it must still answer the same way. Union viewer, matching union.
  IF public.fn_club_home_in_scope(
       '00000000-0000-0000-0000-000000000001'::uuid, false,
       '00000000-0000-0000-0000-0000000000aa'::uuid,
       '00000000-0000-0000-0000-0000000000aa'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       ARRAY[]::uuid[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'union match no longer in scope';
  END IF;
  -- Union viewer, other union, not private: out.
  IF public.fn_club_home_in_scope(
       '00000000-0000-0000-0000-000000000002'::uuid, false,
       '00000000-0000-0000-0000-0000000000bb'::uuid,
       '00000000-0000-0000-0000-0000000000aa'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       ARRAY[]::uuid[]) IS NOT FALSE THEN
    RAISE EXCEPTION 'a different union is in scope';
  END IF;
  -- Union viewer, own club, private: in.
  IF public.fn_club_home_in_scope(
       '00000000-0000-0000-0000-000000000001'::uuid, true,
       '00000000-0000-0000-0000-0000000000bb'::uuid,
       '00000000-0000-0000-0000-0000000000aa'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       ARRAY[]::uuid[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'own private club dropped out of scope';
  END IF;
  -- No union viewer: falls back to the club id list.
  IF public.fn_club_home_in_scope(
       '00000000-0000-0000-0000-000000000003'::uuid, false, NULL, NULL,
       '00000000-0000-0000-0000-000000000001'::uuid,
       ARRAY['00000000-0000-0000-0000-000000000003'::uuid]) IS NOT TRUE THEN
    RAISE EXCEPTION 'club-list fallback no longer matches';
  END IF;
END $$;;
