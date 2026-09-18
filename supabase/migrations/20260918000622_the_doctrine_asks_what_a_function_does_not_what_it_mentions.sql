-- 20260918000622_the_doctrine_asks_what_a_function_does_not_what_it_mentions.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DOCTRINE ASKS WHAT A FUNCTION DOES, NOT WHAT IT MENTIONS.
-- Phase 2 of the horse programme, 2026-09-18. Follows
-- 20260917193840_the_lane_doctrine_answers_in_under_a_second.sql.
--
-- WHAT WAS WRONG (measured on production 2026-09-18, 00:02-00:05 UTC)
--
-- fn_ca_settlement_lane_doctrine() asked its two name questions with LIKE
-- over the whole function source: which functions NAME the finish-lane key,
-- and which NAME the global lane helper. Both are the right questions asked
-- the wrong way, and within six hours both produced a false refusal:
--
--   f_named_only_by_finish_helpers: fn_ca_horse_fleet_metrics
--     - an observer that reads pg_locks and labelled the key in a comment
--       (corrected by 20260917233109, which took the comment out)
--   global_lane_callers_are_reviewed: fn_ca_guard_mtt_admission_contract
--     - a contract guard whose expected manifest pins the signature
--       public.fn_ca_lock_settlement_lane_global() with its definition md5,
--       so that a silent change to the helper is refused. It never calls it.
--
-- A rule that a reader trips by mentioning a name is a rule that turns into
-- an allowlist of everyone who ever wrote the name down, which is not a rule
-- at all. The doctrine exists to say who TAKES a lane.
--
-- WHAT THIS CHANGES
--
-- Rule 2 asks for the hashtextextended() call that turns the finish-lane key
-- into a lock, not for the key's text. Rule 3 and the rolling-authority walk
-- ask for a plpgsql CALL of the global helper - PERFORM, SELECT or an
-- assignment - not for its name; a JSON manifest that pins the signature has
-- a quote in front of it and never matches.
--
-- Measured against the live catalog before applying: 30 functions mention one
-- or the other. The call-shaped tests return exactly the 28 reviewed global
-- authorities plus the two lane helpers, and exactly the three finish helpers
-- for F. fn_ca_guard_mtt_admission_contract answers false to both, which is
-- what it should always have answered.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The doctrine is the one 20260917193840 declared, and it
--    currently refuses the contract guard for naming what it does not call.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
  v_answer jsonb;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_lane_doctrine' AND p.pronargs = 0;
  IF v_md5 IS DISTINCT FROM 'b926f7f5d02c3950db58f9d276808b9c' THEN
    RAISE EXCEPTION 'precondition: fn_ca_settlement_lane_doctrine() is not the 20260917193840 body as 20260917233109 left it (md5 %)', v_md5;
  END IF;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'global_lane_callers_are_reviewed'
       AND v ->> 'found' LIKE '%fn_ca_guard_mtt_admission_contract%'
  ) THEN
    RAISE EXCEPTION 'precondition: the doctrine does not report the contract guard as an unreviewed global caller: %', v_answer;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE DOCTRINE, ASKING FOR CALLS.
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
  -- A CALL of the global helper, not a mention of its name. plpgsql calls it
  -- as PERFORM/SELECT/assignment; a JSON manifest that pins its signature has
  -- a quote in front of it and never matches. Written in pieces so this
  -- function's own source does not match the pattern it carries.
  v_global_call CONSTANT text :=
    '(PERFORM|SELECT|:=)\s+public\.fn_ca_lock_settlement_lane_' || 'global\s*\(';
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

  -- 2. F is TAKEN only by the three finish-lane helpers. The test is the
  --    hashtextextended() call that turns the key into the lock, not the name:
  --    a contract guard that pins the key in a manifest, or an observer that
  --    reads pg_locks, mentions it without ever taking it.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p
   WHERE p.prosrc ~ ('hashtextextended\(\s*''ca:tournament-finish-lane' || ':v1''');
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
     AND p.prosrc ~ v_global_call
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
     AND p.prosrc ~ v_global_call
     AND p.proname::text NOT IN ('fn_ca_lock_settlement_lane_global',
                                 'fn_ca_lock_settlement_lane_for_finish',
                                 'fn_ca_lock_settlement_lane_for_satellite_finish');

  SELECT COALESCE(array_agg(DISTINCT p.proname::text), '{}'::text[]) INTO v_frontier
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     -- Call-shaped, like the global test above: a contract guard whose
     -- manifest pins these signatures is not a rolling authority, and seeding
     -- the walk from it produced a path made entirely of quoted names.
     AND p.prosrc ~ ('(PERFORM|SELECT|:=)\s+public\.(fn_ca_lock_settlement_lane_for_tournament'
                     || '|fn_ca_lock_tournament_seat_acquisition)\s*\(')
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
-- 2. POSTCONDITIONS. The doctrine holds; it still refuses a real taker; and
--    it no longer refuses a function that only names one.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_answer jsonb;
BEGIN
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine reports violations: %', v_answer;
  END IF;

  -- A function that only NAMES the helper is not a caller.
  CREATE FUNCTION public.zz_doctrine_probe_mentions() RETURNS text LANGUAGE sql IMMUTABLE AS
    $probe$ SELECT 'signature: public.fn_ca_lock_settlement_lane_global()' $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: a function that only names the global helper is still refused: %', v_answer;
  END IF;
  DROP FUNCTION public.zz_doctrine_probe_mentions();

  -- A function that CALLS it is still refused.
  CREATE FUNCTION public.zz_doctrine_probe_calls() RETURNS void LANGUAGE plpgsql AS
    $probe$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_global(); END $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'global_lane_callers_are_reviewed'
       AND v ->> 'found' LIKE '%zz_doctrine_probe_calls%'
  ) THEN
    RAISE EXCEPTION 'postcondition: an unreviewed caller of the global helper is no longer refused: %', v_answer;
  END IF;
  DROP FUNCTION public.zz_doctrine_probe_calls();

  -- And a function that TAKES the finish lane is still refused. The probe
  -- spells the key whole, which is what a real taker must do.
  CREATE FUNCTION public.zz_doctrine_probe_takes_f() RETURNS void LANGUAGE plpgsql AS
    $probe$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-finish-lane:v1', 0)); END $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'f_named_only_by_finish_helpers'
       AND v ->> 'found' LIKE '%zz_doctrine_probe_takes_f%'
  ) THEN
    DROP FUNCTION public.zz_doctrine_probe_takes_f();
    RAISE EXCEPTION 'postcondition: a function that takes the finish lane is no longer refused: %', v_answer;
  END IF;
  DROP FUNCTION public.zz_doctrine_probe_takes_f();
END
$post$;

COMMIT;
