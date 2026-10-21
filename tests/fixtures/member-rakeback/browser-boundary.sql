GRANT USAGE ON SCHEMA public,auth TO authenticated;
GRANT SELECT,INSERT,UPDATE ON club_members TO authenticated;
DO $$BEGIN
 BEGIN
  SET LOCAL ROLE authenticated;
  UPDATE club_members SET player_rakeback_pct=.7 WHERE user_id=u(3);
  RAISE EXCEPTION 'FAIL: Direct Player Percentage Bypassed Authorization';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM<>'Individual Rakeback Must Be Set Through Its Agreement RPC' THEN RAISE; END IF;
  RAISE NOTICE 'PASS: Browser Cannot Bypass Percentage Authorization';
 END;
 BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO club_members(club_id,user_id,role,status,player_rakeback_pct)
   VALUES(u(10),u(7),'player','active',.7);
  RAISE EXCEPTION 'FAIL: Browser Inserted A Self Assigned Deal';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM<>'Individual Rakeback Must Be Set Through Its Agreement RPC' THEN RAISE; END IF;
  RAISE NOTICE 'PASS: Browser Cannot Insert A Self Assigned Deal';
 END;
END $$;

-- Owner wallets can have an active agent row; that must not hide the existing
-- club-funded seventy-percent deal or relax ordinary agent-margin rates.
INSERT INTO agents(id,club_id,user_id,role,status,commission_rate,player_rakeback_rate)
 VALUES(u(11),u(10),u(1),'agent','active',.7,.2);
UPDATE club_members SET agent_id=u(1) WHERE user_id=u(4);
SELECT set_config('test.uid',u(1)::text,false);
SELECT assert_true((fn_member_rakeback_terms(u(10),u(4),'player')->>'max_rate')::numeric=.7,'Direct Owner Deal Remains Available');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(4),'player',.7,.2)->>'success')::boolean,'Assign Existing Club Funded Seventy Percent Deal');
SELECT assert_true(fn_player_rakeback_rate(u(4),u(10),0)=.7,'Original Pricing Honors Owner Funded Seventy Percent');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(4),'player',.65,.7)->>'success')::boolean=false,'Ordinary Owner Agent Rates Still Preserve Their Margin');
