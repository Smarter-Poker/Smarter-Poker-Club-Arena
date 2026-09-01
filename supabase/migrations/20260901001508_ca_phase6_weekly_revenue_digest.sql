-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ZERO-DRIFT PHASE 6: the weekly revenue digest. Now that every money path
-- declares a clean ledger category, revenue can be summed from the ledger
-- itself instead of estimated. Runs Mondays 13:00 UTC; one push to the
-- registered platform recipients (kingfish only). Cert/bot flow is broken
-- out so the numbers describe the real economy.
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
  SELECT jsonb_build_object(
    'window_days', p_days,
    'since', v_since,
    'cash_rake', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND category='rake'
                     AND from_type='table_stack'),
    'tournament_and_spin_rake', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND category='rake'
                     AND from_type='prize_liability'),
    'rakeback_paid_to_clubs', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND category='rakeback'),
    'minted', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND from_type IN ('system_mint','issuance_reserve')),
    'burned', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND to_type IN ('system_burn','chip_retirement')),
    'promo_and_leaderboard_spend', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since
                     AND category IN ('promo_send','promo','leaderboard_payout','club_opening_allocation')),
    'bbj_contributions', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since AND category='bbj_contribution'),
    'suspense_flow', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since
                     AND (from_type='settlement_suspense' OR to_type='settlement_suspense')),
    'cert_player_flow', (SELECT round(COALESCE(sum(amount),0),2) FROM chip_ledger
                   WHERE created_at > v_since
                     AND ((from_type='player_wallet' AND public.fn_ca_is_cert_account(from_entity_id))
                       OR (to_type='player_wallet' AND public.fn_ca_is_cert_account(to_entity_id)))),
    'diamond_net', (SELECT round(COALESCE(sum(amount),0),2) FROM diamond_transactions
                   WHERE created_at > v_since),
    'supply_unexplained_net', (SELECT round(COALESCE(sum(unexplained),0),2) FROM ca_supply_snapshots
                   WHERE taken_at > v_since AND unexplained IS NOT NULL),
    'generated_at', now()
  ) INTO v;

  v_msg := 'Cash Rake ' || (v->>'cash_rake')
    || ' | Tournament And Spin Rake ' || (v->>'tournament_and_spin_rake')
    || ' | Rakeback Paid ' || (v->>'rakeback_paid_to_clubs')
    || ' | Minted ' || (v->>'minted') || ' | Burned ' || (v->>'burned')
    || ' | Promo And Leaderboard Spend ' || (v->>'promo_and_leaderboard_spend')
    || ' | BBJ Contributions ' || (v->>'bbj_contributions')
    || ' | Suspense Flow ' || (v->>'suspense_flow')
    || ' | Cert Player Flow (Excluded) ' || (v->>'cert_player_flow')
    || ' | Unexplained Supply Net ' || (v->>'supply_unexplained_net');

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
REVOKE ALL ON FUNCTION public.fn_ca_weekly_revenue_digest(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-revenue-digest-weekly', '0 13 * * 1',
  $$SELECT public.fn_ca_weekly_revenue_digest(7)$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT 'cron', 'ca-revenue-digest-weekly', NULL,
       'Monday 13:00 UTC revenue digest from clean ledger categories, cert flow broken out', true
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory WHERE object_a='ca-revenue-digest-weekly');;
