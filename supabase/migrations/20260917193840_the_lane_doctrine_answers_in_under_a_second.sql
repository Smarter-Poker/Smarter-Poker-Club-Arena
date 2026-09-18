-- 20260917193840_the_lane_doctrine_answers_in_under_a_second.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE LANE DOCTRINE ANSWERS IN UNDER A SECOND.
-- Phase 2 of the horse programme, 2026-09-17. Follows
-- 20260917191322_sweeps_and_satellites_take_their_own_lanes.sql, which
-- declared public.fn_ca_settlement_lane_doctrine() for CI to ask whether a
-- branch put a hot path back on the global settlement lane.
--
-- WHAT WAS WRONG (measured on production 2026-09-17, 19:34 UTC)
--
-- The first doctrine built the whole call graph before walking it: a
-- 3,592 x 3,592 strpos join over 8.7 MB of function source, 8.2-8.7 s per
-- call from psql. The engine role reads through PostgREST under an 8 s
-- statement timeout, so scripts/ci/check-settlement-lane-doctrine.mjs got
-- 57014 "canceling statement due to statement timeout" instead of an answer,
-- and the workflow that exists to refuse a bad merge could only exit 2.
--
-- WHAT THIS CHANGES
--
-- Rule 4 (no rolling authority reaches the global lane within four calls)
-- becomes a breadth-first walk that expands only its frontier. A function's
-- callees are the public function names its source writes with a '(' behind
-- them, read with one regexp pass over that source and an index probe per
-- name, instead of a strpos of every name against every source. Rules 1-3 and
-- the answer's shape are unchanged. Measured in a rolled-back transaction on
-- production: 344-354 ms, ok:true; a probe pair fn_zz_probe_a > fn_zz_probe_b
-- > fn_settle_tournament_rake was reported as a rolling_authority_never_
-- reaches_global_lane violation, and an unlisted caller of the global helper
-- as global_lane_callers_are_reviewed, so the fast walk refuses what the slow
-- one refused.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The doctrine this replaces is the one 20260917191322
--    declared, byte for byte; anything else means another change landed
--    first and this file must be re-read against it.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_lane_doctrine' AND p.pronargs = 0;
  IF v_md5 IS DISTINCT FROM '58ceb0f3dc59f709afbd60fab68477df' THEN
    RAISE EXCEPTION 'precondition: fn_ca_settlement_lane_doctrine() is not the 20260917191322 body (md5 %)', v_md5;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE DOCTRINE, WITH A FRONTIER WALK FOR RULE 4.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_lane_doctrine()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_violations jsonb := '[]'::jsonb;
  v_set text;
  v_path text;
  v_node text;
  v_unknown text;
  v_globals text[];
  v_frontier text[];
  v_visited text[];
  v_next text[];
  v_parent jsonb := '{}'::jsonb;
  v_depth integer;
  r record;
  -- Every function allowed to take the global lane (G and B exclusive):
  -- the rare and cross-tournament authorities reviewed on 2026-09-17. A new
  -- name is a new authority nobody has classified as rolling, finish or
  -- global: it fails CI until someone reads it for what it writes.
  v_global_allowed CONSTANT text[] := ARRAY[
    'atomic_cancel_tournament','fn_award_satellite_seat','fn_backpay_unfinalised_bounty_pools',
    'fn_begin_tournament_deal_review','fn_ca_lock_settlement_lane_for_finish',
    'fn_ca_lock_settlement_lane_for_satellite_finish',
    'fn_ca_return_satellite_entitlement_as_ticket','fn_ca_tournament_deal_snapshot',
    'fn_cancel_tournament_deal_review','fn_close_managed_game','fn_close_tournament_deal_review',
    'fn_complete_tournament_terminal_pre_seat_guard','fn_complete_tournament_terminal_proposal',
    'fn_deliver_satellite_ticket_exact','fn_execute_managed_game_command','fn_finalize_bounty_pool',
    'fn_get_tournament_deal_consensus','fn_mystery_bounty_settle','fn_poker_diamond_tournament_cancel',
    'fn_request_tournament_deal_review','fn_resolve_satellite_settlement_outcome',
    'fn_resolve_tournament_terminal_proposal_outcome','fn_settle_final_table_deal_atomic',
    'fn_settle_satellite_finish_atomic','fn_settle_tournament_final_table_deal',
    'fn_settle_tournament_places','fn_settle_tournament_rake','fn_sweep_unsettled_tournament_rake'];
BEGIN
  IF NOT public.fn_caller_is_engine() AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'lane doctrine is read by the engine role' USING ERRCODE = '42501';
  END IF;

  -- 1. G is taken exclusively only by the two lane helpers.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'pg_advisory_xact_lock\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)';
  IF v_set IS DISTINCT FROM 'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global' THEN
    v_violations := v_violations || jsonb_build_object('rule', 'g_exclusive_only_by_helpers', 'found', v_set);
  END IF;

  -- 2. F is named only by the three finish-lane helpers.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p
   WHERE p.prosrc LIKE '%ca:tournament-finish-lane' || ':v1%';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_finish,fn_ca_lock_settlement_lane_for_satellite_finish,'
     'fn_ca_lock_settlement_lane_for_sweep_member' THEN
    v_violations := v_violations || jsonb_build_object('rule', 'f_named_only_by_finish_helpers', 'found', v_set);
  END IF;

  -- 3. Every function naming the global helper is a reviewed global authority.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_unknown
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%fn_ca_lock_settlement_lane_global' || '(%'
     AND p.proname <> 'fn_ca_lock_settlement_lane_global'
     AND NOT (p.proname::text = ANY (v_global_allowed));
  IF v_unknown IS NOT NULL THEN
    v_violations := v_violations || jsonb_build_object('rule', 'global_lane_callers_are_reviewed', 'found', v_unknown);
  END IF;

  -- 4. No rolling authority reaches the global lane within four calls.
  --    A breadth-first walk from every function that names a rolling lane
  --    helper, expanding only the frontier: the callees of a function are the
  --    public function names its source writes with a '(' behind them. The
  --    first version of this rule (20260917191322) built the whole call graph
  --    with a 3,592 x 3,592 strpos join and took eight seconds, which is
  --    exactly the engine role's statement timeout; CI read a 57014 instead
  --    of an answer. This walk touches a few hundred sources and answers in
  --    well under a second.
  SELECT COALESCE(array_agg(DISTINCT p.proname::text), '{}'::text[]) INTO v_globals
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND strpos(p.prosrc, 'fn_ca_lock_settlement_lane_global' || '(') > 0
     AND p.proname::text NOT IN ('fn_ca_lock_settlement_lane_global',
                                 'fn_ca_lock_settlement_lane_for_finish',
                                 'fn_ca_lock_settlement_lane_for_satellite_finish');

  SELECT COALESCE(array_agg(DISTINCT p.proname::text), '{}'::text[]) INTO v_frontier
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND (strpos(p.prosrc, 'fn_ca_lock_settlement_lane_for_tournament' || '(') > 0
          OR strpos(p.prosrc, 'fn_ca_lock_tournament_seat_acquisition' || '(') > 0)
     AND p.proname::text NOT IN ('fn_ca_lock_settlement_lane_for_tournament',
                                 'fn_ca_lock_tournament_seat_acquisition',
                                 'fn_resolve_tournament_terminal_outcome')
     AND NOT (p.proname::text = ANY (v_globals));
  v_visited := v_frontier;

  <<walk>>
  FOR v_depth IN 1..4 LOOP
    EXIT walk WHEN cardinality(v_frontier) = 0;
    v_next := '{}'::text[];
    FOR r IN
      SELECT DISTINCT ON (c.callee) c.callee, c.caller
        FROM (SELECT a.proname::text AS caller, t.m[1] AS callee
                FROM pg_catalog.pg_proc a
                JOIN pg_catalog.pg_namespace n ON n.oid = a.pronamespace
                CROSS JOIN LATERAL regexp_matches(a.prosrc, '\m([A-Za-z_][A-Za-z0-9_]*)\(', 'g') AS t(m)
               WHERE n.nspname = 'public' AND a.prokind = 'f'
                 AND a.proname::text = ANY (v_frontier)) c
       WHERE c.callee <> c.caller
         AND length(c.callee) > 6
         AND NOT (c.callee = ANY (v_visited))
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc b
                       JOIN pg_catalog.pg_namespace nb ON nb.oid = b.pronamespace
                      WHERE nb.nspname = 'public' AND b.prokind = 'f'
                        AND b.proname = c.callee::name)
       ORDER BY c.callee, c.caller
    LOOP
      v_parent := v_parent || jsonb_build_object(r.callee, r.caller);
      v_next := v_next || r.callee;
      IF r.callee = 'fn_ca_lock_settlement_lane_global' OR r.callee = ANY (v_globals) THEN
        v_path := r.callee;
        v_node := r.caller;
        WHILE v_node IS NOT NULL LOOP
          v_path := v_node || ' > ' || v_path;
          v_node := v_parent ->> v_node;
        END LOOP;
        v_violations := v_violations || jsonb_build_object('rule', 'rolling_authority_never_reaches_global_lane', 'found', v_path);
        EXIT walk;
      END IF;
    END LOOP;
    v_visited := v_visited || v_next;
    v_frontier := v_next;
  END LOOP walk;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_violations) = 0,
    'checked_at', now(),
    'violations', v_violations);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. POSTCONDITIONS. The doctrine still answers, still says the schema is
--    clean, and no longer builds the whole graph.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_answer jsonb;
  v_src text;
BEGIN
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine reports violations: %', v_answer;
  END IF;
  IF jsonb_typeof(v_answer -> 'violations') <> 'array' OR jsonb_array_length(v_answer -> 'violations') <> 0 THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine answer is malformed: %', v_answer;
  END IF;
  SELECT p.prosrc INTO v_src
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_lane_doctrine' AND p.pronargs = 0;
  IF v_src NOT LIKE '%<<walk>>%' OR v_src LIKE '%edges AS (%' THEN
    RAISE EXCEPTION 'postcondition: the doctrine body is not the frontier walk';
  END IF;
END
$post$;

COMMIT;
