-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820135052 "union_law_p6_expel_club_governance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f8dd2f80efcb869da1c7941ca5b683cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P6 — UNION CAN EXPEL A CLUB, SAFELY (2026-08-20)
--
-- PokerBros: the union owner "sets policy, can expel a club". We had a
-- union_leave_requests table but no function anywhere that actually removes a
-- club from a union — so the union's core governance power did not exist.
--
-- Removing a club is dangerous while money is in flight, so this refuses
-- unless the club is quiet, and reports exactly what is blocking:
--   * players still seated in union games on that club's chips
--   * unsettled rake for the current period
--   * outstanding agent credit
-- p_force lets the union owner override deliberately (recorded in the audit
-- trail with the blockers that were overridden).
--
-- On success it detaches the club from the union, clears the mirrored
-- clubs.union_id, and leaves the club's own chips/treasury untouched — the
-- club keeps its money, it simply stops sharing the union pool.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_club_exit_blockers(p_union_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_seated bigint; v_entries bigint; v_unsettled numeric; v_credit numeric;
BEGIN
  SELECT count(*) INTO v_seated
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL AND ts.club_id = p_club_id AND t.union_id = p_union_id;

  SELECT count(*) INTO v_entries
    FROM tournament_players tp JOIN tournaments t ON t.id = tp.tournament_id
   WHERE tp.club_id = p_club_id AND t.union_id = p_union_id
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING');

  SELECT COALESCE(SUM(amount),0) INTO v_unsettled
    FROM union_wallet_transactions
   WHERE union_id = p_union_id AND club_id = p_club_id
     AND wallet = 'rake_wallet' AND direction = 'credit' AND tx_type = 'rake'
     AND created_at >= date_trunc('week', now());

  SELECT COALESCE(SUM(credit_used),0) INTO v_credit
    FROM agents WHERE club_id = p_club_id AND status = 'active';

  RETURN jsonb_build_object(
    'players_seated_in_union_games', v_seated,
    'live_tournament_entries', v_entries,
    'unsettled_rake_this_period', round(v_unsettled,2),
    'agent_credit_outstanding', round(v_credit,2),
    'clear_to_exit', (v_seated = 0 AND v_entries = 0 AND v_unsettled = 0 AND v_credit = 0)
  );
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_expel_club(p_union_id uuid, p_club_id uuid, p_reason text DEFAULT NULL, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_blockers jsonb; v_is_member boolean;
BEGIN
  IF NOT public.fn_is_union_overseer(p_union_id, auth.uid()) AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT EXISTS (SELECT 1 FROM union_clubs WHERE union_id = p_union_id AND club_id = p_club_id)
    INTO v_is_member;
  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'club_not_in_union');
  END IF;

  v_blockers := public.fn_union_club_exit_blockers(p_union_id, p_club_id);

  IF NOT (v_blockers->>'clear_to_exit')::boolean AND NOT p_force THEN
    RETURN jsonb_build_object('success', false, 'error', 'club_not_quiet',
                              'blockers', v_blockers,
                              'hint', 'settle and empty the club, or call with p_force => true');
  END IF;

  DELETE FROM union_clubs WHERE union_id = p_union_id AND club_id = p_club_id;
  UPDATE clubs SET union_id = NULL, updated_at = now()
   WHERE id = p_club_id AND union_id = p_union_id;

  -- The club stops hosting union games; its own private games are unaffected.
  UPDATE tables SET union_id = NULL, updated_at = now()
   WHERE club_id = p_club_id AND union_id = p_union_id;
  UPDATE tournaments SET union_id = NULL, updated_at = now()
   WHERE club_id = p_club_id AND union_id = p_union_id;

  UPDATE unions SET club_count = GREATEST(COALESCE(club_count,1) - 1, 0), updated_at = now()
   WHERE id = p_union_id;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id, reason)
  VALUES (auth.uid(), 'union_owner', 'expel_club_from_union', 'club', p_club_id,
          COALESCE(p_reason,'no reason given')
            || CASE WHEN p_force THEN ' [FORCED over blockers: ' || v_blockers::text || ']' ELSE '' END);

  INSERT INTO financial_alerts (severity, source, message, context)
  VALUES (CASE WHEN p_force THEN 'critical' ELSE 'warning' END,
          'fn_union_expel_club',
          'Club removed from union' || CASE WHEN p_force THEN ' (FORCED)' ELSE '' END,
          jsonb_build_object('union_id', p_union_id, 'club_id', p_club_id,
                             'reason', p_reason, 'blockers', v_blockers));

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
                            'forced', p_force, 'blockers_at_exit', v_blockers);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_expel_club(uuid, uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_exit_blockers(uuid, uuid) TO authenticated;

