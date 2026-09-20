-- 20260918001056_the_doctrine_narrows_before_it_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DOCTRINE NARROWS BEFORE IT READS.
-- Phase 2 of the horse programme, 2026-09-18. Performance correction to
-- 20260918000622_the_doctrine_asks_what_a_function_does_not_what_it_mentions.sql,
-- applied twenty minutes earlier.
--
-- WHAT WAS WRONG (measured on production 2026-09-18, 00:09 UTC)
--
-- Asking for a CALL instead of a name meant a regular expression where there
-- had been a LIKE, and a regex over every function source in the schema -
-- 3,592 functions, 8.7 MB of text - took 4.4 and 6.1 seconds end to end.
-- The engine role reads this through PostgREST under an 8 s statement
-- timeout. 20260917193840 exists because the doctrine once crossed that
-- timeout and CI read 57014 instead of an answer; this was two seconds from
-- doing it again, which is not a margin.
--
-- WHAT THIS CHANGES
--
-- Every full-catalog scan runs a LIKE first and the regular expression only
-- over what the LIKE kept. Each regex is strictly narrower than the LIKE in
-- front of it, so every answer is unchanged; only the work is. Nothing else
-- in the body moves.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITION. The doctrine is the one 20260918000622 declared.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settlement_lane_doctrine' AND p.pronargs = 0;
  IF v_md5 IS DISTINCT FROM '735277b492c875b36a4bd55be7a640da' THEN
    RAISE EXCEPTION 'precondition: fn_ca_settlement_lane_doctrine() is not the 20260918000622 body (md5 %)', v_md5;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE DOCTRINE, NARROWING BEFORE IT READS.
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
     AND p.prosrc LIKE '%ca:tournament-terminal-' || 'settlement:v1%'
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
     -- The LIKE runs first and is what makes this cheap: a regex over 3,592
     -- sources and 8.7 MB of text took 4-6 s, against an 8 s statement
     -- timeout on the engine role that reads this through PostgREST. The
     -- regex is strictly narrower than the LIKE, so the answer is the same.
   WHERE p.prosrc LIKE '%ca:tournament-finish-lane' || ':v1%'
     AND p.prosrc ~ ('hashtextextended\(\s*''ca:tournament-finish-lane' || ':v1''');
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
     AND p.prosrc LIKE '%fn_ca_lock_settlement_lane_' || 'global(%'
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
     AND p.prosrc LIKE '%fn_ca_lock_settlement_lane_' || 'global(%'
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
     AND (p.prosrc LIKE '%fn_ca_lock_settlement_lane_for_' || 'tournament(%'
          OR p.prosrc LIKE '%fn_ca_lock_tournament_seat_' || 'acquisition(%')
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
                -- A CALL, not a mention: this codebase always calls a public
                -- function schema-qualified, and the character in front of it
                -- is whitespace, an opening paren or a comma. A JSON manifest
                -- writes the same signature behind an escaped quote, which is
                -- how a contract guard became a rolling authority on
                -- 2026-09-18 and put fn_award_satellite_seat behind it.
                CROSS JOIN LATERAL regexp_matches(
                  a.prosrc, '(?:^|[[:space:](,])public\.([a-z_][a-z_0-9]*)[[:space:]]*\(', 'g') AS t(m)
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
-- 2. POSTCONDITIONS. The same three answers as 20260918000622, and a bound on
--    how long the question may take.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_answer jsonb;
  v_started timestamptz;
  v_ms numeric;
BEGIN
  v_started := clock_timestamp();
  v_answer := public.fn_ca_settlement_lane_doctrine();
  v_ms := extract(epoch FROM (clock_timestamp() - v_started)) * 1000;
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine reports violations: %', v_answer;
  END IF;
  IF v_ms > 2000 THEN
    RAISE EXCEPTION 'postcondition: the doctrine answered in % ms, which leaves no margin under the 8 s engine statement timeout', round(v_ms);
  END IF;

  CREATE FUNCTION public.zz_doctrine_probe_mentions() RETURNS text LANGUAGE sql IMMUTABLE AS
    $probe$ SELECT 'signature: public.fn_ca_lock_settlement_lane_global()' $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  DROP FUNCTION public.zz_doctrine_probe_mentions();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: a function that only names the global helper is refused: %', v_answer;
  END IF;

  CREATE FUNCTION public.zz_doctrine_probe_calls() RETURNS void LANGUAGE plpgsql AS
    $probe$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_global(); END $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  DROP FUNCTION public.zz_doctrine_probe_calls();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'global_lane_callers_are_reviewed'
       AND v ->> 'found' LIKE '%zz_doctrine_probe_calls%'
  ) THEN
    RAISE EXCEPTION 'postcondition: an unreviewed caller of the global helper is not refused: %', v_answer;
  END IF;

  CREATE FUNCTION public.zz_doctrine_probe_takes_f() RETURNS void LANGUAGE plpgsql AS
    $probe$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-finish-lane:v1', 0)); END $probe$;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  DROP FUNCTION public.zz_doctrine_probe_takes_f();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'f_named_only_by_finish_helpers'
       AND v ->> 'found' LIKE '%zz_doctrine_probe_takes_f%'
  ) THEN
    RAISE EXCEPTION 'postcondition: a function that takes the finish lane is not refused: %', v_answer;
  END IF;
END
$post$;

COMMIT;
