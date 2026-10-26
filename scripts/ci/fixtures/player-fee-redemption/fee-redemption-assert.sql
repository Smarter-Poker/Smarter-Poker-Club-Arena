DO $$
DECLARE v numeric; j jsonb; before_j jsonb; after_j jsonb;
BEGIN
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,'69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT v=373.06, 'original redemption must reach member Cash Fees';
  SELECT tournament_fees INTO v FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,'69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT v=3.5, 'MTT fees unchanged';
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,'2026-10-22','69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT v=644.66, 'period before redemption unchanged';
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,'11111111-1111-1111-1111-111111111111');
  ASSERT v=9, 'other player unchanged';
  j := ca_player_rake_stats('69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT (j->>'rake_paid')::numeric=373.06, 'player rake stats adjusted';
  ASSERT (j->>'gross_rake_paid')::numeric=695.39, 'gross preserved';
  ASSERT (j->>'hands')::int=2, 'hands unchanged';
  ASSERT (j->>'rake_in_bb')::numeric=347.70, 'physical hand evidence unchanged';
  ASSERT ca_player_rake_stats('69f2cefa-017d-49f3-ac3e-61505633747c')=j, 'repeat read cannot halve twice';
  j := ca_player_rake_stats_by_club('69f2cefa-017d-49f3-ac3e-61505633747c',null,'chips','a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
  ASSERT (j->>'rake_paid')::numeric=373.06, 'club player rake stats adjusted';
  j := ca_player_rake_stats_by_club('69f2cefa-017d-49f3-ac3e-61505633747c',null,'diamonds','a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
  ASSERT (j->>'fee_redemption')::numeric=0, 'diamonds unaffected';
  j := ca_player_rake_stats_by_club('69f2cefa-017d-49f3-ac3e-61505633747c',null,'chips','11111111-1111-1111-1111-111111111111');
  ASSERT (j->>'fee_redemption')::numeric=0, 'other club unaffected';
  ASSERT (SELECT sum(rake_paid) FROM ca_hand_facts)=695.39, 'hand source never rewritten';
  BEGIN
    INSERT INTO smarter_private.player_fee_redemptions SELECT * FROM smarter_private.player_fee_redemptions;
    RAISE EXCEPTION 'duplicate operation accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT NOT has_table_privilege('authenticated','smarter_private.player_fee_redemptions','SELECT'), 'redemption cannot leak through direct API';
  INSERT INTO ca_hand_facts VALUES ('69f2cefa-017d-49f3-ac3e-61505633747c','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,null,now(),10,2);
  UPDATE ca_club_rake_daily_user SET rake_cents=rake_cents+1000 WHERE user_id='69f2cefa-017d-49f3-ac3e-61505633747c' AND day='2026-10-23';
  j := ca_player_rake_stats('69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT (j->>'rake_paid')::numeric=383.06, 'future rake accumulates at full value';
  SELECT cash_fees INTO v FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,'69f2cefa-017d-49f3-ac3e-61505633747c');
  ASSERT v=383.06, 'member fees accumulate at full value';
  RAISE NOTICE 'fee redemption: all assertions passed';
END $$;
