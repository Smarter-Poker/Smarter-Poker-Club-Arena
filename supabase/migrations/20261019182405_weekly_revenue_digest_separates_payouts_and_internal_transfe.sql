-- Revenue digest: classify the actual destination, not successive transfer legs.
-- Original audit 2026-10-19: 2,769,287.58 rakeback included 588,824.90 onward
-- player payments; 512,949.42 promo included 451,800.00 opening transfer legs.
-- A zero signed snapshot sum also concealed 21 nonzero observations.
-- Read-only figures; notifications remain in the existing scheduled product.
-- No wallet writes, new schedule, historical notification rewrite or payout.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $pre$
BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_weekly_revenue_digest(integer)'::regprocedure))
   IS DISTINCT FROM 'abfc1fa7eb75da6b3bbefb229bcf01e4' THEN
   RAISE EXCEPTION 'weekly_revenue_digest_preimage_changed' USING ERRCODE='55000';
 END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_ca_weekly_revenue_digest(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(p_days,1));
  v jsonb; v_msg text; r uuid;
BEGIN
  -- One statement/snapshot. Posted transfer volume is not revenue or spend.
  WITH legs AS MATERIALIZED (
    SELECT l.amount,l.category,l.from_type,l.to_type,l.from_entity_id,l.to_entity_id FROM public.chip_ledger l
    WHERE l.created_at > v_since AND l.created_at <= now() AND l.status='posted'
  ), totals AS (
    SELECT
      COALESCE(sum(amount) FILTER(WHERE category='rake' AND from_type='table_stack'),0) cash_rake,
      COALESCE(sum(amount) FILTER(WHERE category='rake' AND from_type='prize_liability'),0) tournament_rake,
      COALESCE(sum(amount) FILTER(WHERE category='rakeback' AND from_type='union_wallet' AND to_type='club_treasury'),0) club_rakeback,
      COALESCE(sum(amount) FILTER(WHERE category='rakeback' AND to_type='player_wallet'),0) player_rakeback,
      COALESCE(sum(amount) FILTER(WHERE category='rakeback'),0) rakeback_volume,
      COALESCE(sum(amount) FILTER(WHERE category='rakeback' AND
        ((from_type='union_wallet' AND to_type='club_treasury') OR to_type='player_wallet') IS NOT TRUE),0) other_rakeback,
      COALESCE(sum(amount) FILTER(WHERE from_type IN('system_mint','issuance_reserve')),0) minted,
      COALESCE(sum(amount) FILTER(WHERE to_type IN('system_burn','chip_retirement')),0) burned,
      COALESCE(sum(amount) FILTER(WHERE category IN('promo_send','promo','leaderboard_payout')
        AND to_type IN('player_wallet','table_stack')),0) player_promo,
      COALESCE(sum(amount) FILTER(WHERE category IN('promo_send','promo','leaderboard_payout')
        AND (to_type IN('player_wallet','table_stack')) IS NOT TRUE),0) promo_funding,
      COALESCE(sum(amount) FILTER(WHERE category='club_opening_allocation' AND from_type='club_treasury' AND to_type='opening_setup'),0) opening_setup,
      COALESCE(sum(amount) FILTER(WHERE category='club_opening_allocation' AND from_type='opening_setup' AND to_type IN('bbj_pool','spin_reserve')),0) opening_reserves,
      COALESCE(sum(amount) FILTER(WHERE category='bbj_contribution'),0) bbj,
      COALESCE(sum(amount) FILTER(WHERE from_type='settlement_suspense' OR to_type='settlement_suspense'),0) suspense,
      COALESCE(sum(amount) FILTER(WHERE (from_type='player_wallet' AND public.fn_ca_is_cert_account(from_entity_id))
        OR (to_type='player_wallet' AND public.fn_ca_is_cert_account(to_entity_id))),0) cert_flow
    FROM legs
  ), snapshots AS (
    SELECT count(*) observations,count(unexplained) comparable,
      count(*) FILTER(WHERE unexplained<>0) nonzero,
      count(DISTINCT basis_version) bases,
      sum(unexplained) signed_net,sum(abs(unexplained)) absolute_movement,
      max(abs(unexplained)) maximum_movement,min(taken_at) first_at,max(taken_at) last_at
    FROM public.ca_supply_snapshots WHERE taken_at>v_since AND taken_at<=now()
  )
  SELECT jsonb_build_object(
    'digest_version',2,'window_days',p_days,'since',v_since,'until',now(),
    'cash_rake',round(t.cash_rake,2),'tournament_and_spin_rake',round(t.tournament_rake,2),
    'rakeback_paid_to_clubs',round(t.club_rakeback,2),
    'rakeback_paid_to_players',round(t.player_rakeback,2),
    'rakeback_transfer_volume',round(t.rakeback_volume,2),
    'other_rakeback_transfers',round(t.other_rakeback,2),
    'minted',round(t.minted,2),'burned',round(t.burned,2),
    'promo_and_leaderboard_spend',round(t.player_promo,2),
    'promo_funding_transfers',round(t.promo_funding,2),
    'opening_setup_transfers',round(t.opening_setup,2),
    'opening_reserve_allocations',round(t.opening_reserves,2),
    'bbj_contributions',round(t.bbj,2),'suspense_flow',round(t.suspense,2),
    'cert_player_flow',round(t.cert_flow,2),
    'cert_flow_treatment','reported_separately_not_subtracted',
    'diamond_net',(SELECT round(COALESCE(sum(amount),0),2) FROM public.diamond_transactions
      WHERE created_at>v_since AND created_at<=now()),
    -- No observation is NULL, never a fabricated 0. Netting is not a verdict.
    'supply_unexplained_net',round(s.signed_net,2),
    'supply_absolute_unexplained',round(s.absolute_movement,2),
    'supply_maximum_unexplained',round(s.maximum_movement,2),
    'supply_snapshot_count',s.observations,'supply_comparable_count',s.comparable,
    'supply_nonzero_count',s.nonzero,'supply_first_at',s.first_at,'supply_last_at',s.last_at,
    'supply_status',CASE WHEN s.observations=0 THEN 'no_observations'
      WHEN s.comparable<>s.observations OR s.bases<>1 THEN 'basis_transition_or_incomplete'
      WHEN s.nonzero>0 THEN 'nonzero_observations' ELSE 'zero_observations_not_account_certification' END,
    'generated_at',now()
  ) INTO v FROM totals t CROSS JOIN snapshots s;

  v_msg := 'Cash Rake ' || (v->>'cash_rake')
    || ' | Tournament And Spin Rake ' || (v->>'tournament_and_spin_rake')
    || ' | Club Rakeback ' || (v->>'rakeback_paid_to_clubs')
    || ' | Player Rakeback ' || (v->>'rakeback_paid_to_players')
    || ' | Player Promo And Leaderboard ' || (v->>'promo_and_leaderboard_spend')
    || ' | Minted ' || (v->>'minted') || ' | Burned ' || (v->>'burned')
    || ' | BBJ Contributions ' || (v->>'bbj_contributions')
    || ' | Supply Status ' || (v->>'supply_status');

  FOR r IN SELECT user_id FROM ca_incident_recipients WHERE active
  LOOP
    INSERT INTO notifications (user_id, type, title, message, data)
    VALUES (r, 'financial_digest',
            'Weekly Revenue Digest (' || p_days || 'd)',
            left(v_msg, 500),
            jsonb_build_object('digest', v));
  END LOOP;

  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_weekly_revenue_digest(integer) FROM PUBLIC,anon,authenticated;
COMMIT;
