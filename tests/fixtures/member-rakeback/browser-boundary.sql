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
