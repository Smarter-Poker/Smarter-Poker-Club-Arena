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

  IF NOT EXISTS(SELECT 1 FROM public.club_member_daily_facts_state WHERE singleton AND initialized)
  THEN RAISE EXCEPTION 'Member daily facts are not initialized'; END IF;

  WITH agg AS (
    SELECT coalesce(sum(f.hands),0)::bigint AS hands,
           coalesce(sum(f.wins),0)::bigint AS wins,
           coalesce(sum(f.vpip_hands),0)::bigint AS vpip_hands,
           coalesce(sum(f.pfr_hands),0)::bigint AS pfr_hands,
           coalesce(sum(f.tb_hands),0)::bigint AS tb_hands,
           coalesce(sum(f.faced_tb),0)::bigint AS faced_tb,
           coalesce(sum(f.folded_tb),0)::bigint AS folded_tb,
           coalesce(sum(f.cb_hands),0)::bigint AS cb_hands,
           coalesce(sum(f.cb_opps),0)::bigint AS cb_opps,
           coalesce(sum(f.fees) FILTER (WHERE f.played_on >= public.fn_ca_fee_counting_start()),0) AS fees,
           coalesce(sum(f.net) FILTER (WHERE NOT f.is_mtt),0) AS net
      FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) f
     WHERE f.club_id=p_club_id AND f.user_id=p_user_id
       AND (v_variant IS NULL OR v_variant='all' OR f.game_variant=v_variant)
       AND (p_from IS NULL OR f.played_on>=p_from)
       AND (p_to IS NULL OR f.played_on<=p_to)
  ), vars AS (
    SELECT coalesce(jsonb_agg(v.game_variant ORDER BY v.game_variant),'[]'::jsonb) AS list
      FROM (SELECT DISTINCT f.game_variant FROM public.ca_member_record_daily_facts(p_club_id,p_user_id,NULL,NULL) f
             WHERE f.club_id=p_club_id AND f.user_id=p_user_id
               AND f.game_variant IS NOT NULL AND f.hands>0) v
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
    'net', round(a.net + CASE WHEN v_variant IS NULL OR v_variant='all'
      THEN coalesce(public.ca_club_member_tournament_money(p_club_id, p_user_id, v_from, v_to), 0)
      ELSE coalesce((SELECT sum(leg.signed) FROM (
             SELECT l.amount AS signed
               FROM public.chip_ledger l JOIN public.tournaments t ON t.id = l.tournament_id
              WHERE l.club_id = p_club_id AND l.to_entity_id = p_user_id
                AND l.to_type = 'player_wallet' AND l.from_type = 'prize_liability'
                AND l.tournament_id IS NOT NULL AND l.status = 'posted'
                AND (v_from IS NULL OR l.created_at >= v_from)
                AND (v_to IS NULL OR l.created_at < v_to)
                AND lower(t.game_type) = v_variant
             UNION ALL
             SELECT -l.amount
               FROM public.chip_ledger l JOIN public.tournaments t ON t.id = l.tournament_id
              WHERE l.club_id = p_club_id AND l.from_entity_id = p_user_id
                AND l.from_type = 'player_wallet' AND l.to_type = 'prize_liability'
                AND l.tournament_id IS NOT NULL AND l.status = 'posted'
                AND (v_from IS NULL OR l.created_at >= v_from)
                AND (v_to IS NULL OR l.created_at < v_to)
                AND lower(t.game_type) = v_variant) leg), 0) END, 2),
    'fees', CASE WHEN v_variant IS NULL OR v_variant='all'
                 THEN coalesce((SELECT lf.total_fees FROM public.ca_club_member_fee_totals(p_club_id, p_from, p_to, p_user_id) lf
                                 WHERE lf.user_id=p_user_id), 0)
                 ELSE round(a.fees + coalesce((
                   -- member_variant_tournament_fee_receipts
                   SELECT sum(receipt.rake_credit)
                     FROM public.accounting_tournament_fee_sources receipt
                     JOIN public.tournaments tournament ON tournament.id=receipt.tournament_id
                    WHERE receipt.club_id=p_club_id AND receipt.player_id=p_user_id
                      AND lower(tournament.game_type)=v_variant
                      AND receipt.charged_at >= greatest(coalesce(p_from,public.fn_ca_fee_counting_start()),public.fn_ca_fee_counting_start())::timestamp AT TIME ZONE 'UTC'
                      AND (v_to IS NULL OR receipt.charged_at < v_to)
                 ),0),2) END,
    'from', p_from, 'to', p_to, 'is_overall', p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$
;
