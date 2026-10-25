-- After 20261025030629: the standing WooWoo-to-KingFish share is applied by the
-- three readers at read time, exactly and immediately, and nothing schedules a
-- write to the redemptions any more.
DO $$
DECLARE
  w constant uuid := '69f2cefa-017d-49f3-ac3e-61505633747c';
  k constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v numeric; j jsonb;
BEGIN
  -- The compensating write is gone: job, function and its rows.
  ASSERT NOT EXISTS (SELECT 1 FROM cron.job), 'the cron job is unscheduled';
  ASSERT to_regprocedure('smarter_private.fn_woowoo_half_rake_to_kingfish_sync()') IS NULL, 'sync function dropped';
  ASSERT NOT EXISTS (SELECT 1 FROM smarter_private.player_fee_redemptions WHERE operation_key LIKE '%-split-%'), 'split rows deleted';
  -- The declared one-off events remain.
  ASSERT (SELECT array_agg(operation_key || ':' || amount_cents ORDER BY operation_key) FROM smarter_private.player_fee_redemptions)
       = ARRAY['kingfish-from-woowoo-half-earned-rake-20261024:-52052',
               'woowoo-half-earned-rake-20261024:52052',
               'woowoo-lifetime-vip-20261023:32233'], 'fixed events kept';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='player_fee_redemptions_amount_cents_check') = 'CHECK ((amount_cents <> 0))', 'credit rows allowed';
  ASSERT (SELECT share_bps FROM smarter_private.player_rake_share_rules WHERE rule_key='woowoo-half-rake-to-kingfish-20261024') = 5000, 'the rule is declared';
  ASSERT NOT has_table_privilege('authenticated','smarter_private.player_rake_share_rules','SELECT'), 'rule table is service-only';
  ASSERT has_table_privilege('service_role','smarter_private.player_rake_share_rules','SELECT'), 'service role reads the rule';
  ASSERT NOT has_function_privilege('authenticated','smarter_private.fn_player_rake_share_hand_cents(uuid,timestamptz,text)','EXECUTE'), 'helper is service-only';

  -- Cash Fees: share of the attributions B, C and D (89.48 + 10.00 + 3.02).
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals(c, null, null, k);
  ASSERT v = 571.77, format('KingFish fees include the lagging hand: %s', v);
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals(c, null, null, w);
  ASSERT v = -79.21, format('WooWoo fees give the same cents: %s', v);
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals(c, null, '2026-10-23', k);
  ASSERT v IS NULL, 'nothing is shared before the cutoff day';
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals(c, null, null, '11111111-1111-1111-1111-111111111111');
  ASSERT v = 9, 'other player unchanged';

  -- Player statistics: share of the hand facts B, C, D and the fixture's
  -- earlier hand (89.48 + 10.00 + 3.02 + 10.00), never of A (before the cutoff).
  j := ca_player_rake_stats(k);
  ASSERT (j->>'rake_paid')::numeric = 576.77, format('KingFish rake stats: %s', j);
  ASSERT (j->>'rake_share')::numeric = 56.25 AND (j->>'hands')::int = 0, 'KingFish receives without hands';
  j := ca_player_rake_stats(w);
  ASSERT (j->>'rake_paid')::numeric = -84.21 AND (j->>'rake_share')::numeric = -56.25, format('WooWoo rake stats: %s', j);
  ASSERT (j->>'gross_rake_paid')::numeric = 814.89 AND (j->>'fee_redemption')::numeric = 899.10, 'gross hand evidence unchanged';
  ASSERT ca_player_rake_stats(w) = j, 'a repeat read never shares twice';
  j := ca_player_rake_stats_by_club(k, null, 'chips', c);
  ASSERT (j->>'rake_paid')::numeric = 576.77, format('KingFish club rake stats: %s', j);
  j := ca_player_rake_stats_by_club(w, null, 'chips', c);
  ASSERT (j->>'rake_paid')::numeric = -84.21, format('WooWoo club rake stats: %s', j);
  j := ca_player_rake_stats_by_club(k, null, 'chips', '11111111-1111-1111-1111-111111111111');
  ASSERT (j->>'rake_share')::numeric = 0, 'other club unaffected';
  j := ca_player_rake_stats(k, null, 'diamonds');
  ASSERT (j->>'rake_share')::numeric = 0, 'diamonds unaffected';

  -- Immediate: the next KINGS hand is shared at once, by every reader.
  INSERT INTO ca_hand_facts VALUES (w,'fade0000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000000f',null,now(),2.00,0.5);
  INSERT INTO rake_attributions(hand_id,player_id,club_id,rake_amount,created_at) VALUES ('00000000-0000-0000-0000-00000000000f',w,c,2.00,now());
  INSERT INTO ca_club_rake_daily_user VALUES (c,w,(now() AT TIME ZONE 'UTC')::date,200);
  ASSERT (ca_player_rake_stats(k)->>'rake_paid')::numeric = 577.77, 'KingFish gains half at once';
  ASSERT (ca_player_rake_stats(w)->>'rake_paid')::numeric = -83.21, 'WooWoo keeps half at once';
  ASSERT (SELECT cash_fees FROM ca_club_member_fee_totals(c, null, null, k)) = 572.77, 'KingFish fees gain half at once';
  ASSERT (SELECT cash_fees FROM ca_club_member_fee_totals(c, null, null, w)) = -78.21, 'WooWoo fees keep half at once';

  -- A hand funded by another club is not KINGS rake and is not shared.
  INSERT INTO ca_hand_facts VALUES (w,'fade0000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000000e',null,now(),4.00,0.5);
  INSERT INTO cash_participant_funding_receipts VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000e1',w,now()-interval '1 minute','22222222-2222-2222-2222-222222222222','buyin',now());
  ASSERT (ca_player_rake_stats(k)->>'rake_paid')::numeric = 577.77, 'other-club hand not shared';
  ASSERT (ca_player_rake_stats(w)->>'rake_paid')::numeric = -79.21, 'WooWoo keeps all of it';
  ASSERT (ca_player_rake_stats_by_club(w, null, 'chips', c)->>'rake_paid')::numeric = -83.21, 'not KINGS rake';

  -- Ending the rule ends the share at that instant, in every reader.
  UPDATE smarter_private.player_rake_share_rules SET effective_until = '2026-10-25 00:00:00+00';
  ASSERT (ca_player_rake_stats(k)->>'rake_paid')::numeric = 565.26, 'only hand B was inside the rule';
  ASSERT (SELECT cash_fees FROM ca_club_member_fee_totals(c, null, null, k)) = 565.26, 'fees follow the same window';
  BEGIN
    INSERT INTO smarter_private.player_rake_share_rules(rule_key,club_id,from_user,to_user,share_bps,effective_from,reason)
    VALUES ('self','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',w,w,5000,now(),repeat('x',40));
    RAISE EXCEPTION 'a player shared rake with itself';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'rake share: all assertions passed';
END $$;
