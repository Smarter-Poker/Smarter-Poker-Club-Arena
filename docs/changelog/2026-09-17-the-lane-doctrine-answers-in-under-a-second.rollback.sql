-- Rollback for 20260917193840_the_lane_doctrine_answers_in_under_a_second.sql
-- Restores the doctrine body 20260917191322 declared (prosrc md5 58ceb0f3dc59f709afbd60fab68477df).
-- Byte for byte from that migration; read the forward file before running this.

BEGIN;
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
  v_unknown text;
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
  WITH RECURSIVE fns AS (
    SELECT DISTINCT ON (p.proname) p.proname::text AS proname, p.prosrc
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
     ORDER BY p.proname, p.oid),
  globals AS (
    SELECT proname FROM fns
     WHERE strpos(prosrc, 'fn_ca_lock_settlement_lane_global' || '(') > 0
       AND proname NOT IN ('fn_ca_lock_settlement_lane_global',
                           'fn_ca_lock_settlement_lane_for_finish',
                           'fn_ca_lock_settlement_lane_for_satellite_finish')),
  edges AS (
    SELECT a.proname AS caller, b.proname AS callee
      FROM fns a JOIN fns b ON b.proname <> a.proname
       AND length(b.proname) > 6
       AND strpos(a.prosrc, b.proname || '(') > 0),
  walk(node, path, depth) AS (
    SELECT f.proname, f.proname, 0 FROM fns f
     WHERE (strpos(f.prosrc, 'fn_ca_lock_settlement_lane_for_tournament' || '(') > 0
            OR strpos(f.prosrc, 'fn_ca_lock_tournament_seat_acquisition' || '(') > 0)
       AND f.proname NOT IN ('fn_ca_lock_settlement_lane_for_tournament',
                             'fn_ca_lock_tournament_seat_acquisition',
                             'fn_resolve_tournament_terminal_outcome')
       AND f.proname NOT IN (SELECT proname FROM globals)
    UNION ALL
    SELECT e.callee, w.path || ' > ' || e.callee, w.depth + 1
      FROM walk w JOIN edges e ON e.caller = w.node
     WHERE w.depth < 4 AND strpos(w.path, e.callee) = 0)
  SELECT path INTO v_path FROM walk
   WHERE depth > 0
     AND (node IN (SELECT proname FROM globals) OR node = 'fn_ca_lock_settlement_lane_global')
   LIMIT 1;
  IF v_path IS NOT NULL THEN
    v_violations := v_violations || jsonb_build_object('rule', 'rolling_authority_never_reaches_global_lane', 'found', v_path);
  END IF;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_violations) = 0,
    'checked_at', now(),
    'violations', v_violations);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;

COMMIT;
