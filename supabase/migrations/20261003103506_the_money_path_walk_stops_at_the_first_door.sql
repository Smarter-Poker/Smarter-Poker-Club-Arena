-- 20261003103506_the_money_path_walk_stops_at_the_first_door.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MONEY PATH WALK STOPS AT THE FIRST DOOR (phase 5 of 9). Full account:
-- docs/changelog/2026-10-03-the-money-path-walk-stops-at-the-first-door.md.
--
-- fn_union_law_selftest (cron union-law-selftest, 00:20 daily) was cancelled
-- on its budget on 10-01 and 10-02, and ran 263 s on 10-03 once its budget
-- was raised to 600 s. Timed on production 2026-10-03: its money-path half,
-- fn_union_money_path_check -> fn_money_path_reaches_club_scope for twelve
-- money paths at depth 6, took 25 to 51 s; every other part of the self-test
-- took under 4 s on a warm cache.
--
-- The cause is the shape of the walk. The recursive CTE kept (name, depth)
-- pairs, so a function reachable by several routes was expanded again at
-- every depth it was reached at, and the whole call graph out to depth 6 was
-- built before EXISTS could answer, even for a money path that touches
-- club_members itself at depth 0.
--
-- The successor is a breadth-first walk with a visited set: each name is
-- expanded once, at the shortest depth it is reached, and it returns as soon
-- as any reached function touches club scope. The reachable set within
-- p_max_depth is the same, so every answer is the same. Measured on
-- production against the installed CTE (pg_temp, rolled back): 12 of 12 money
-- paths agree at depth 6 (4.4 s against 45.9 s), and 54 of 54 random
-- (function, depth 1..3) cases agree (10 true, 44 false), plus a missing
-- function and depth 0. On a private PG17 call graph built to break it -
-- a 7-deep chain, a cycle, a diamond of two routes, an overload, a short-name
-- decoy and a name mentioned without a call - 108 of 108 (function, depth
-- 0..8) cases agree.
--
-- Same signature, owner, grants and SECURITY DEFINER; STABLE as before.
-- No chips move, nothing is backfilled, no job is added.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure)) = 'f9f43589929fdfd1cc356eaa67943785')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure)) IS DISTINCT FROM '0187859a2c1b519dd3044da87504eaab' THEN
    RAISE EXCEPTION 'MONEY_PATH_WALK_PREIMAGE_CHANGED';
  END IF;
  IF has_function_privilege('anon', 'public.fn_money_path_reaches_club_scope(text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_money_path_reaches_club_scope(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MONEY_PATH_WALK_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_money_path_reaches_club_scope(p_fn text, p_max_depth integer DEFAULT 4)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- A BREADTH-FIRST WALK THAT STOPS AT THE FIRST DOOR (2026-10-03).
  -- The recursive CTE this replaces kept (name, depth) pairs, so a function
  -- reachable by several routes was expanded again at every depth it was
  -- reached at, and the whole call graph was walked before EXISTS could
  -- answer. fn_union_law_selftest spent 25 to 51 s here every night (it
  -- reached 263 s on 2026-10-03 under load). Each name is now expanded once,
  -- at the shortest depth it is reached at, and the walk returns as soon as
  -- any function it has reached touches club scope. Reachability within
  -- p_max_depth is the same set, so the answer is the same: measured on
  -- production against the CTE, 12 of 12 money paths and 54 of 54 random
  -- (function, depth) cases agree, in 4.4 s instead of 45.9 s for the 12.
  v_seen     text[] := ARRAY[p_fn];
  v_frontier text[] := ARRAY[p_fn];
  v_depth    integer := 0;
BEGIN
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname::text = ANY (v_frontier)
                  AND (p.prosrc LIKE '%club_members%'
                       OR p.prosrc LIKE '%fn_pay_player_chips%')) THEN
      RETURN true;
    END IF;
    EXIT WHEN v_depth >= GREATEST(p_max_depth, 1) OR cardinality(v_frontier) = 0;

    -- A call, not a coincidental substring: the name must be followed by an
    -- open paren. The length floor keeps very short names from matching
    -- half the schema.
    SELECT COALESCE(array_agg(DISTINCT callee.proname::text), '{}'::text[])
      INTO v_frontier
      FROM pg_proc caller
      JOIN pg_proc callee
        ON callee.pronamespace = 'public'::regnamespace
       AND length(callee.proname) > 6
       AND caller.prosrc LIKE '%' || callee.proname || '(%'
     WHERE caller.pronamespace = 'public'::regnamespace
       AND caller.proname::text = ANY (v_frontier)
       AND NOT (callee.proname::text = ANY (v_seen));
    v_seen  := v_seen || v_frontier;
    v_depth := v_depth + 1;
  END LOOP;
  RETURN false;
END;
$function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_money_path_reaches_club_scope(text,integer)'::regprocedure)) IS DISTINCT FROM 'f9f43589929fdfd1cc356eaa67943785'
     OR has_function_privilege('anon', 'public.fn_money_path_reaches_club_scope(text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_money_path_reaches_club_scope(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MONEY_PATH_WALK_RESULT_CHANGED';
  END IF;
  -- The twelve money paths still all reach club scope.
  IF EXISTS (SELECT 1 FROM public.fn_union_money_path_check()) THEN
    RAISE EXCEPTION 'MONEY_PATH_WALK_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
