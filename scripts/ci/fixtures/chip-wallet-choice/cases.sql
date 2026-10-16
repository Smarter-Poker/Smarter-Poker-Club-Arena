DO $test$
DECLARE
 c uuid:='00000000-0000-0000-0000-000000000001';
 sender uuid:='00000000-0000-0000-0000-000000000003';
 recipient uuid:='00000000-0000-0000-0000-000000000004';
 player uuid:='00000000-0000-0000-0000-000000000005';
 v_op uuid; r jsonb; replay jsonb; wallet text; role_name text; before_source numeric; before_player numeric; before_agent numeric; n int:=0;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',sender::text,true);
 FOREACH role_name IN ARRAY ARRAY['owner','co_owner','super_agent','agent','sub_agent'] LOOP
  UPDATE club_members SET role=role_name WHERE user_id=recipient;
  FOREACH wallet IN ARRAY ARRAY['player_wallet','agent_wallet'] LOOP
   v_op:=gen_random_uuid();
   SELECT agent_wallet_balance INTO before_source FROM agents WHERE user_id=sender;
   SELECT agent_wallet_balance INTO before_agent FROM agents WHERE user_id=recipient;
   SELECT chip_balance INTO before_player FROM club_members WHERE user_id=recipient;
   r:=fn_agent_wallet_send_phase2_core_20260831(c,recipient,5,wallet,'wallet choice',v_op);
   IF r->>'success' <> 'true' OR r->>'destination' <> wallet THEN RAISE EXCEPTION 'wrong destination for %/%: %',role_name,wallet,r; END IF;
   IF (SELECT agent_wallet_balance FROM agents WHERE user_id=sender) <> before_source-5
      OR (SELECT agent_wallet_balance FROM agents WHERE user_id=recipient) <> before_agent+(CASE WHEN wallet='agent_wallet' THEN 5 ELSE 0 END)
      OR (SELECT chip_balance FROM club_members WHERE user_id=recipient) <> before_player+(CASE WHEN wallet='player_wallet' THEN 5 ELSE 0 END) THEN RAISE EXCEPTION 'wrong balance'; END IF;
   replay:=fn_agent_wallet_send_phase2_core_20260831(c,recipient,5,wallet,'wallet choice',v_op);
   IF replay->>'replayed' <> 'true' OR replay->>'transaction_id' <> r->>'transaction_id' THEN RAISE EXCEPTION 'replay failed'; END IF;
   replay:=fn_agent_wallet_send_phase2_core_20260831(c,recipient,5,CASE WHEN wallet='player_wallet' THEN 'agent_wallet' ELSE 'player_wallet' END,'wallet choice',v_op);
   IF replay->>'success' <> 'false' THEN RAISE EXCEPTION 'changed wallet reused key'; END IF;
   IF (SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'=v_op::text)<>1 OR (SELECT count(*) FROM journal j WHERE j.op='agent_send:'||v_op::text)<>1 THEN RAISE EXCEPTION 'duplicate journal/transaction'; END IF;
   n:=n+1;
  END LOOP;
 END LOOP;
 UPDATE club_members SET role='admin' WHERE user_id=recipient;
 r:=fn_agent_wallet_send_phase2_core_20260831(c,recipient,5,'player_wallet',NULL,gen_random_uuid());
 IF r->>'success'<>'false' OR r->>'error'<>'An Admin Does Not Hold A Player Wallet' THEN RAISE EXCEPTION 'admin player credit accepted'; END IF;
 r:=fn_agent_wallet_send_phase2_core_20260831(c,player,5,'agent_wallet',NULL,gen_random_uuid());
 IF r->>'success'<>'false' THEN RAISE EXCEPTION 'player float accepted'; END IF;
 r:=fn_agent_wallet_send_phase2_core_20260831(c,sender,5,'player_wallet',NULL,gen_random_uuid());
 IF r->>'success'<>'false' THEN RAISE EXCEPTION 'agent self send accepted'; END IF;
 UPDATE club_members SET agent_id=NULL WHERE user_id=recipient;
 r:=fn_agent_wallet_send_phase2_core_20260831(c,recipient,5,'agent_wallet',NULL,gen_random_uuid());
 IF r->>'success'<>'false' THEN RAISE EXCEPTION 'outside downline accepted'; END IF;
 RAISE NOTICE '% successful role/wallet cases plus replay, conflict, accounting and refusal cases',n;
END $test$;
SELECT 'wallet-choice-passed';
DO $bank$
DECLARE c uuid:='00000000-0000-0000-0000-000000000001'; u uuid:='00000000-0000-0000-0000-000000000002'; w text; r jsonb; again jsonb; bank_op uuid; b numeric;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',u::text,true);
 FOREACH w IN ARRAY ARRAY['player_wallet','agent_wallet'] LOOP
  SELECT chip_treasury INTO b FROM clubs WHERE id=c;
  bank_op:=gen_random_uuid(); r:=fn_club_bank_send(c,u,5,w,NULL,bank_op);
  IF r->>'success'<>'true' OR r->>'destination'<>w OR (SELECT chip_treasury FROM clubs WHERE id=c)<>b-5 THEN RAISE EXCEPTION 'bank self wallet failed: %',r; END IF;
  again:=fn_club_bank_send(c,u,5,w,NULL,bank_op);
  IF again->>'replayed'<>'true' OR again->>'transaction_id'<>r->>'transaction_id' OR (SELECT chip_treasury FROM clubs WHERE id=c)<>b-5 THEN RAISE EXCEPTION 'bank replay failed'; END IF;
  IF (SELECT count(*) FROM journal WHERE op='club_bank_send:'||bank_op::text)<>1 THEN RAISE EXCEPTION 'bank journal failed'; END IF;
 END LOOP;
END $bank$;
SELECT 'bank-wallet-choice-passed';
