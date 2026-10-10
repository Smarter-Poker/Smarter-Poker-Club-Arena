CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(p_club_id uuid, p_user_id uuid, p_variant text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := NULLIF(lower(btrim(COALESCE(p_variant, ''))), '');
  v_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_viewer_is_member boolean;
  v_target_is_member boolean;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff','downline','service') THEN
    -- A member of the club asking about somebody who is not one is told so;
    -- anyone else is told only that they may not look.
    v_viewer_is_member := auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = auth.uid()
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    v_target_is_member := EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = p_club_id AND cm.user_id = p_user_id
         AND coalesce(cm.status, 'approved') IN ('active', 'approved'));
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', CASE WHEN v_viewer_is_member AND NOT v_target_is_member
                     THEN 'not_member' ELSE 'restricted' END);
  END IF;

  WITH agg AS (
    SELECT count(DISTINCT f.hand_id)::bigint hands,
           count(DISTINCT f.hand_id) FILTER (WHERE f.net > 0)::bigint wins,
           count(*) FILTER (WHERE f.vpip)::bigint vpip_hands,
           count(*) FILTER (WHERE f.pfr)::bigint pfr_hands,
           count(*) FILTER (WHERE f.three_bet)::bigint tb_hands,
           -- faced_three_bet: this player OPENED and was 3-bet. The
           -- denominator of fold-to-3-bet, never of 3-bet.
           count(*) FILTER (WHERE f.faced_three_bet)::bigint faced_tb,
           count(*) FILTER (WHERE f.folded_to_three_bet)::bigint folded_tb,
           count(*) FILTER (WHERE f.cbet_flop)::bigint cb_hands,
           count(*) FILTER (WHERE f.had_cbet_flop_opp)::bigint cb_opps,
           COALESCE(sum(f.net),0) net, COALESCE(sum(f.rake_paid),0) fees
      FROM public.ca_hand_facts f
     WHERE f.club_id = p_club_id AND f.user_id = p_user_id
       AND (v_variant IS NULL OR v_variant = 'all' OR lower(f.game_variant) = v_variant)
       AND (v_from IS NULL OR f.played_at >= v_from) AND (v_to IS NULL OR f.played_at < v_to)
  ), vars AS (
    SELECT COALESCE(jsonb_agg(v.game_variant ORDER BY v.game_variant), '[]'::jsonb) list
      FROM (SELECT DISTINCT lower(f.game_variant) game_variant FROM public.ca_hand_facts f
             WHERE f.club_id = p_club_id AND f.user_id = p_user_id
               AND f.game_variant IS NOT NULL) v
  )
  SELECT jsonb_build_object(
    'authorized', true, 'variant', COALESCE(v_variant,'all'), 'variants', vars.list,
    'hands', a.hands,
    'hands_won', a.wins,
    'win_rate', COALESCE(round(100.0*a.wins/NULLIF(a.hands,0),2),0),
    'vpip', COALESCE(round(100.0*a.vpip_hands/NULLIF(a.hands,0),2),0),
    'pfr',  COALESCE(round(100.0*a.pfr_hands/NULLIF(a.hands,0),2),0),
    -- 3-bets per hand dealt. Not per opportunity: the facts table does not
    -- record whether this player faced an open they could have 3-bet.
    'three_bet', COALESCE(round(100.0*a.tb_hands/NULLIF(a.hands,0),2),0),
    'three_bet_basis', 'hands',
    'three_bets', a.tb_hands,
    'fold_to_three_bet', COALESCE(round(100.0*a.folded_tb/NULLIF(a.faced_tb,0),2),0),
    'faced_three_bets', a.faced_tb,
    'cbet', COALESCE(round(100.0*a.cb_hands/NULLIF(a.cb_opps,0),2),0),
    'cbet_opportunities', a.cb_opps,
    'net', round(a.net,2), 'fees', round(a.fees,2),
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$;
