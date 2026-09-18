-- Rollback for 20260918000622 and 20260918001056.
-- Restores the doctrine body 20260917233109 left in place (prosrc md5
-- b926f7f5d02c3950db58f9d276808b9c): the name-shaped rules that refused
-- fn_ca_horse_fleet_metrics and fn_ca_guard_mtt_admission_contract for
-- naming lanes they never take. Byte for byte from 20260917193840.

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

COMMIT;
