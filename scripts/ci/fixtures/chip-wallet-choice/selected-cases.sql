-- Every source and every wallet is asserted independently, including legacy
-- promo compatibility. All synthetic rows belong to this isolated cluster.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
DO $$ DECLARE c uuid:='00000000-0000-0000-0000-000000000001'; actor uuid:='00000000-0000-0000-0000-000000000002'; target uuid:='00000000-0000-0000-0000-000000000003'; source text; dest text; v_op uuid; batch uuid; r jsonb; before_bank numeric; before_promo numeric; before_agent numeric; before_player numeric; before_actor_player numeric; before_own_promo numeric; before_target_agent numeric; before_target_promo numeric; tx uuid; BEGIN
 FOREACH source IN ARRAY ARRAY['agent_wallet','club_bank','promo_wallet','club_promo_wallet','player_wallet'] LOOP
  FOREACH dest IN ARRAY ARRAY['agent_wallet','player_wallet','promo_wallet'] LOOP
   SELECT chip_treasury,promo_balance INTO before_bank,before_promo FROM clubs WHERE id=c;
   SELECT agent_wallet_balance,promo_wallet_balance INTO before_agent,before_own_promo FROM agents WHERE club_id=c AND user_id=actor;
   SELECT chip_balance INTO before_actor_player FROM club_members WHERE club_id=c AND user_id=actor;
   SELECT chip_balance INTO before_player FROM club_members WHERE club_id=c AND user_id=target;
   SELECT agent_wallet_balance,promo_wallet_balance INTO before_target_agent,before_target_promo FROM agents WHERE club_id=c AND user_id=target;
   v_op:=gen_random_uuid(); batch:=gen_random_uuid();
   r:=fn_cashier_batch_transfer(c,'send',jsonb_build_array(jsonb_build_object('user_id',target,'amount',3,'source',source,'destination',dest,'op_id',v_op)),batch);
   ASSERT r->'results'->0->>'success'='true',r::text;
   ASSERT (SELECT chip_balance FROM club_members WHERE club_id=c AND user_id=target)=before_player+CASE WHEN dest='player_wallet' THEN 3 ELSE 0 END,r::text;
   ASSERT (SELECT agent_wallet_balance FROM agents WHERE club_id=c AND user_id=target)=before_target_agent+CASE WHEN dest='agent_wallet' THEN 3 ELSE 0 END,r::text;
   ASSERT (SELECT promo_wallet_balance FROM agents WHERE club_id=c AND user_id=target)=before_target_promo+CASE WHEN dest='promo_wallet' THEN 3 ELSE 0 END,r::text;
   ASSERT (SELECT chip_treasury FROM clubs WHERE id=c)=before_bank-CASE WHEN source='club_bank' THEN 3 ELSE 0 END;
   ASSERT (SELECT promo_balance FROM clubs WHERE id=c)=before_promo-CASE WHEN source='club_promo_wallet' THEN 3 ELSE 0 END;
   ASSERT (SELECT agent_wallet_balance FROM agents WHERE club_id=c AND user_id=actor)=before_agent-CASE WHEN source='agent_wallet' THEN 3 ELSE 0 END;
   ASSERT (SELECT chip_balance FROM club_members WHERE club_id=c AND user_id=actor)=before_actor_player-CASE WHEN source='player_wallet' THEN 3 ELSE 0 END;
   ASSERT (SELECT promo_wallet_balance FROM agents WHERE club_id=c AND user_id=actor)=before_own_promo-CASE WHEN source='promo_wallet' THEN 3 ELSE 0 END;
   ASSERT (SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'=v_op::text)=1;
   ASSERT (SELECT count(*) FROM journal j WHERE j.op LIKE '%'||v_op::text)=1;
   ASSERT (SELECT to_type FROM journal j WHERE j.op LIKE '%'||v_op::text)=dest;
   r:=fn_cashier_batch_transfer(c,'send',jsonb_build_array(jsonb_build_object('user_id',target,'amount',3,'source',source,'destination',dest,'op_id',v_op)),batch);
   ASSERT r->'results'->0->>'replayed'='true',r::text;
   r:=fn_cashier_batch_transfer(c,'send',jsonb_build_array(jsonb_build_object('user_id',target,'amount',3,'source',CASE WHEN source='club_bank' THEN 'agent_wallet' ELSE 'club_bank' END,'destination',dest,'op_id',v_op)),batch);
   ASSERT r->'results'->0->>'success'='false',r::text;
   ASSERT (SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'=v_op::text)=1;
   IF source='agent_wallet' AND dest='promo_wallet' THEN
    SELECT id INTO tx FROM chip_transactions WHERE metadata->>'op_id'=v_op::text;
    r:=fn_agent_wallet_claim_back_phase2_core_20260831(c,tx,NULL,NULL,gen_random_uuid());
    ASSERT r->>'success'='true',r::text;
    ASSERT (SELECT promo_wallet_balance FROM agents WHERE club_id=c AND user_id=target)=before_target_promo;
    ASSERT (SELECT agent_wallet_balance FROM agents WHERE club_id=c AND user_id=actor)=before_agent;
   END IF;
  END LOOP;
 END LOOP;
 r:=fn_promo_wallet_send(c,target,2,'agent_wallet',NULL,gen_random_uuid());
 ASSERT r->>'success'='true',r::text;
 ASSERT (SELECT to_type FROM journal ORDER BY ctid DESC LIMIT 1)='promo_wallet';
 r:=fn_cashier_batch_transfer(c,'send',jsonb_build_array(jsonb_build_object('user_id',target,'amount',3,'source','unknown','destination','agent_wallet','op_id',gen_random_uuid())),gen_random_uuid());
 ASSERT r->>'success'='false';
END $$;
-- Authorization and self funding use the existing owners, never a client role.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_cashier_batch_transfer('00000000-0000-0000-0000-000000000001','send',jsonb_build_array(jsonb_build_object('user_id','00000000-0000-0000-0000-000000000004','amount',1,'source','club_bank','destination','agent_wallet','op_id',gen_random_uuid())),gen_random_uuid());
 ASSERT r->'results'->0->>'success'='false',r::text;
END $$;
SELECT 'selected-wallet-routing-passed';

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_cashier_recipient_wallet_balances('00000000-0000-0000-0000-000000000001',ARRAY['00000000-0000-0000-0000-000000000003'::uuid]);
 ASSERT jsonb_array_length(r)=1 AND (r->0 ? 'agent_wallet') AND (r->0 ? 'promo_wallet') AND (r->0 ? 'player_wallet');
 ASSERT has_function_privilege('authenticated','fn_cashier_recipient_wallet_balances(uuid,uuid[])','EXECUTE');
 ASSERT NOT has_function_privilege('anon','fn_cashier_recipient_wallet_balances(uuid,uuid[])','EXECUTE');
 ASSERT NOT has_function_privilege('anon','fn_cashier_player_wallet_send(uuid,uuid,numeric,text,text,uuid)','EXECUTE');
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
DO $$ BEGIN
 BEGIN PERFORM fn_cashier_recipient_wallet_balances('00000000-0000-0000-0000-000000000001',ARRAY['00000000-0000-0000-0000-000000000002'::uuid]); RAISE EXCEPTION 'Unauthorized Read Passed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
CREATE FUNCTION journal_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.amount=13 THEN RAISE EXCEPTION 'Synthetic Journal Refusal'; END IF; RETURN NEW; END $$;
CREATE TRIGGER journal_fault BEFORE INSERT ON journal FOR EACH ROW EXECUTE FUNCTION journal_fault();
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
DO $$ DECLARE source text; before_state jsonb; r jsonb; op uuid; BEGIN
 FOREACH source IN ARRAY ARRAY['agent_wallet','club_bank','promo_wallet','club_promo_wallet','player_wallet'] LOOP
  SELECT jsonb_build_array((SELECT jsonb_agg(jsonb_build_array(user_id,chip_balance) ORDER BY user_id) FROM club_members),(SELECT jsonb_agg(jsonb_build_array(user_id,agent_wallet_balance,promo_wallet_balance) ORDER BY user_id) FROM agents),(SELECT jsonb_agg(jsonb_build_array(id,chip_treasury,promo_balance) ORDER BY id) FROM clubs)) INTO before_state;
  op:=gen_random_uuid();
  r:=fn_cashier_batch_transfer('00000000-0000-0000-0000-000000000001','send',jsonb_build_array(jsonb_build_object('user_id','00000000-0000-0000-0000-000000000003','amount',13,'source',source,'destination','promo_wallet','op_id',op)),gen_random_uuid());
  ASSERT r->'results'->0->>'success'='false',r::text;
  ASSERT NOT EXISTS(SELECT 1 FROM chip_transactions WHERE metadata->>'op_id'=op::text);
  ASSERT NOT EXISTS(SELECT 1 FROM test_intents WHERE id=op);
  ASSERT before_state=jsonb_build_array((SELECT jsonb_agg(jsonb_build_array(user_id,chip_balance) ORDER BY user_id) FROM club_members),(SELECT jsonb_agg(jsonb_build_array(user_id,agent_wallet_balance,promo_wallet_balance) ORDER BY user_id) FROM agents),(SELECT jsonb_agg(jsonb_build_array(id,chip_treasury,promo_balance) ORDER BY id) FROM clubs));
 END LOOP;
END $$;
SELECT 'selected-wallet-failure-atomicity-passed';
-- Promo destinations retain the existing credit repayment and expiry rules.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SELECT set_config('app.ledger_autoskip_agents','1',false);
UPDATE agents SET agent_wallet_balance=0,is_prepaid=false,credit_limit=100,credit_used=0 WHERE user_id='00000000-0000-0000-0000-000000000002';
SELECT set_config('app.ledger_autoskip_agents','',false);
DO $$ DECLARE c uuid:='00000000-0000-0000-0000-000000000001'; a uuid:='00000000-0000-0000-0000-000000000002'; target uuid:='00000000-0000-0000-0000-000000000003'; r jsonb; tx uuid; before_promo numeric; BEGIN
 SELECT promo_wallet_balance INTO before_promo FROM agents WHERE user_id=target;
 r:=fn_agent_wallet_send(c,target,4,'promo_wallet',NULL,gen_random_uuid()); ASSERT r->>'success'='true',r::text; tx:=(r->>'transaction_id')::uuid;
 ASSERT (SELECT credit_used FROM agents WHERE user_id=a)=4;
 r:=fn_agent_wallet_claim_back_phase2_core_20260831(c,tx,2,NULL,gen_random_uuid()); ASSERT r->>'success'='true',r::text;
 ASSERT (SELECT credit_used FROM agents WHERE user_id=a)=2;
 r:=fn_agent_wallet_claim_back_phase2_core_20260831(c,tx,NULL,NULL,gen_random_uuid()); ASSERT r->>'success'='true',r::text;
 ASSERT (SELECT credit_used FROM agents WHERE user_id=a)=0;
 ASSERT (SELECT promo_wallet_balance FROM agents WHERE user_id=target)=before_promo;
 r:=fn_agent_wallet_send(c,target,1,'promo_wallet',NULL,gen_random_uuid()); tx:=(r->>'transaction_id')::uuid;
 UPDATE chip_transactions SET reversible_until=now()-interval '1 minute' WHERE id=tx;
 r:=fn_agent_wallet_claim_back_phase2_core_20260831(c,tx,NULL,NULL,gen_random_uuid()); ASSERT r->>'success'='false';
END $$;
SELECT 'selected-wallet-credit-and-expiry-passed';
