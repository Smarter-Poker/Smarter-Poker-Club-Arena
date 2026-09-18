-- Append to the exact retained legacy satellite/restart fixture. Synthetic
-- starting users/roster/balances are inputs; all tested creations, purchases,
-- receipts and ABI transitions execute current origin authorities.
BEGIN;
DO $$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_isolation_[0-9a-f]{32}$'
    OR (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)<>'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'ACTIVATION_TRANSITION_OWNED_LEGACY_INPUT_REQUIRED';
 END IF;
END $$;
CREATE SCHEMA r46_activation;
REVOKE ALL ON SCHEMA r46_activation FROM PUBLIC;
CREATE TABLE r46_activation.observations(actor text PRIMARY KEY,receipt jsonb NOT NULL);
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('46468100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,4)n;
INSERT INTO public.users(id,username) SELECT id,'activation_'||id::text FROM auth.users WHERE id::text LIKE '46468100-%';
INSERT INTO public.profiles(id,username) SELECT id,'activation_'||id::text FROM auth.users WHERE id::text LIKE '46468100-%';
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)
SELECT '46462000-0000-4000-8000-000000000002',id,'player','active',1000,now()-interval '1 day'
 FROM auth.users WHERE id::text LIKE '46468100-%';
-- Synthetic historical agreement baseline, like the opening wallet/roster.
-- This is not a claim of an exercised join workflow or a financial receipt.
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,after_terms)
SELECT 'club_members',club_id::text||':'||user_id::text,club_id,user_id,'baseline',
 public.fn_accounting_agreement_terms('club_members',to_jsonb(m)) FROM public.club_members m
 WHERE user_id::text LIKE '46468100-%';
INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
VALUES('46468101-0000-4000-8000-000000000004','46468100-0000-4000-8000-000000000004',now(),now());
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,status,chips,club_id)
SELECT md5('activation-existing:'||n)::uuid,'46462000-0000-4000-8000-000000000003',
 ('46468100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Existing synthetic entrant','registered',10000,
 '46462000-0000-4000-8000-000000000002' FROM generate_series(1,@INITIAL_COUNT@)n;
UPDATE public.tournaments SET max_players=3,current_players=(SELECT count(*) FROM public.tournament_players WHERE tournament_id=tournaments.id)
 WHERE id='46462000-0000-4000-8000-000000000003';
SET LOCAL session_replication_role=origin;
CREATE FUNCTION r46_activation.money() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb:=r46_mtt_isolation.economic_snapshot(); r record; value jsonb; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND (c.relname LIKE 'accounting_tournament_%'
   OR c.relname IN ('tournament_participant_funding_receipts','tournament_accounting_credit_receipts',
    'tournament_obligation_events','union_pnl_transaction_frames','union_pnl_original_flows','union_pnl_inventory_events')) LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',r.relname) INTO value;
  result:=result||jsonb_build_object(r.relname,value);
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION r46_activation.pristine() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM r46_mtt_isolation.assert_true((SELECT abi='legacy-capacity-v1' FROM public.ca_mtt_admission_contract)
   AND NOT EXISTS(SELECT 1 FROM r46_activation.observations)
   AND NOT EXISTS(SELECT 1 FROM r46_mtt_isolation.connections),'fresh real activation transition fixture');
END $$;
CREATE FUNCTION r46_activation.create_event(p_actor text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cfg jsonb; r jsonb; BEGIN
 cfg:=r46_mtt_isolation.config('Actual transition creator');
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 SET LOCAL ROLE service_role;
 r:=public.fn_ensure_scheduled_mtt_satellite(cfg);
 RESET ROLE;
 PERFORM r46_mtt_isolation.assert_true(r->'ok'='true' AND r->>'outcome'='created','actual dual creator accepted');
 INSERT INTO r46_activation.observations VALUES(p_actor,r);
END $$;
CREATE FUNCTION r46_activation.enter_event(p_actor text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"46468100-0000-4000-8000-000000000004","session_id":"46468101-0000-4000-8000-000000000004"}',true);
 SET LOCAL ROLE authenticated;
 r:=public.fn_register_for_tournament_request('46462000-0000-4000-8000-000000000003','46468102-0000-4000-8000-000000000004');
 RESET ROLE;
 INSERT INTO r46_activation.observations VALUES(p_actor,r);
END $$;
-- @ACTUAL_ROW_ACTIVATION@
CREATE FUNCTION r46_activation.blocked(p_owner text,p_waiter text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM r46_mtt_isolation.blocked(p_owner,p_waiter);
END $$;
CREATE FUNCTION r46_activation.verify_final(p_case text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE activation_first boolean:=p_case LIKE '%activation_first%';
 rolled boolean:=p_case LIKE '%rollback'; creation boolean:=p_case LIKE 'creator_%';
 expected_abi text; op_actor text; r jsonb; t public.tournaments%ROWTYPE; ok boolean; replay jsonb;
 prior_money jsonb; prior_receipt jsonb; BEGIN
 expected_abi:=CASE WHEN activation_first AND rolled THEN 'legacy-capacity-v1' ELSE 'unlimited-mtt-v2' END;
 op_actor:=CASE WHEN activation_first THEN 'b' ELSE 'a' END;
 PERFORM r46_mtt_isolation.assert_true((SELECT abi=expected_abi FROM public.ca_mtt_admission_contract),'actual activation commit/rollback exact ABI');
 SELECT receipt INTO r FROM r46_activation.observations WHERE actor=op_actor;
 IF NOT activation_first AND rolled THEN
  PERFORM r46_mtt_isolation.assert_true(r IS NULL,'rolled-back operation leaves no receipt');
 ELSE
  PERFORM r46_mtt_isolation.assert_true(r IS NOT NULL,'committed operation has exact receipt');
 END IF;
 IF creation THEN
  IF NOT activation_first AND rolled THEN
   PERFORM r46_mtt_isolation.assert_true((SELECT count(*)=2 FROM public.tournaments),'rolled-back legacy creation is absent');
  ELSE
   SELECT * INTO STRICT t FROM public.tournaments WHERE id=(r->>'tournament_id')::uuid;
   IF activation_first AND NOT rolled THEN
    PERFORM r46_mtt_isolation.assert_true(t.format_contract='mtt-v2' AND t.max_players IS NULL AND t.min_players=3
      AND t.starting_chips=10000 AND t.buy_in_amount=90 AND t.buy_in_fee=10 AND r->'table_id'='null'::jsonb,
      'creator after actual activation selects genuine scheduled contract');
   ELSE
    PERFORM r46_mtt_isolation.assert_true(t.format_contract='seat-first-satellite-v1' AND t.max_players=2 AND t.min_players=2
      AND t.starting_chips=300 AND t.buy_in_amount=142.5 AND t.buy_in_fee=7.5
      AND EXISTS(SELECT 1 FROM public.tables WHERE id=(r->>'table_id')::uuid AND tournament_id=t.id AND max_players=2),
      'creator before activation preserves genuine fixed HU contract and actual table');
   END IF;
   prior_money:=r46_activation.money();
   PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
   replay:=public.fn_ensure_scheduled_mtt_satellite(r46_mtt_isolation.config('Actual transition replay'));
   PERFORM r46_mtt_isolation.assert_true(replay->>'outcome'='existing_active'
     AND replay->'tournament_id'=r->'tournament_id' AND replay->'format_contract'=r->'format_contract'
     AND replay->'table_id'=r->'table_id' AND r46_activation.money()=prior_money,
     'cross-activation same-id replay preserves persisted format/table and money');
  END IF;
 ELSE
  ok:=NOT rolled OR activation_first=false AND rolled=false;
  -- Old admission commits its third entry; new admission commits a fourth only
  -- after activation. An activation rollback retains a full legacy cap.
  IF activation_first AND rolled THEN
   PERFORM r46_mtt_isolation.assert_true(r->'ok'='false'::jsonb AND r->>'reason'='tournament_full','rollback keeps full legacy registration refusal');
  ELSIF NOT rolled THEN
   PERFORM r46_mtt_isolation.assert_true(r->'ok'='true'::jsonb AND (r->>'cost')::numeric=200
     AND (r->>'rake')::numeric=20,'real request-bound registration charges exact booked200/20');
  END IF;
  PERFORM r46_mtt_isolation.assert_true((SELECT chip_balance=CASE WHEN ok THEN 800 ELSE 1000 END
   FROM public.club_members WHERE club_id='46462000-0000-4000-8000-000000000002' AND user_id='46468100-0000-4000-8000-000000000004'),
   'only committed successful registration changes actual club wallet');
  PERFORM r46_mtt_isolation.assert_true((SELECT count(*)=CASE WHEN ok THEN 1 ELSE 0 END FROM public.tournament_refund_entitlements
   WHERE tournament_id='46462000-0000-4000-8000-000000000003' AND user_id='46468100-0000-4000-8000-000000000004'
     AND entitlement_kind='wallet_charge' AND gross=200 AND refund_prize=180 AND refund_fee=20 AND refund_bounty=0),
   'exact committed financial entitlement, absent on refusal/rollback');
  PERFORM r46_mtt_isolation.assert_true((SELECT current_players=(CASE WHEN activation_first THEN 3 ELSE 2 END)+(CASE WHEN ok THEN 1 ELSE 0 END)
    AND current_players=(SELECT count(*) FROM public.tournament_players WHERE tournament_id=parent.id)
    FROM public.tournaments parent WHERE id='46462000-0000-4000-8000-000000000003'),
    'committed fourth entry exceeds raw legacy cap only under unlimited ABI');
  PERFORM r46_mtt_isolation.assert_true((SELECT count(*)=CASE WHEN ok THEN 1 ELSE 0 END FROM public.accounting_tournament_fee_batches
    WHERE tournament_id='46462000-0000-4000-8000-000000000003' AND rake_amount=20 AND status='captured'),
    'successful charge commits an actual captured accounting fee batch');
  IF ok THEN
   prior_money:=r46_activation.money(); prior_receipt:=r;
   -- The SAME request must return its original accepted receipt after the ABI
   -- changes and must not debit or mint another entitlement.
   DELETE FROM r46_activation.observations WHERE actor=op_actor;
   PERFORM r46_activation.enter_event(op_actor);
   SELECT receipt INTO replay FROM r46_activation.observations WHERE actor=op_actor;
   PERFORM r46_mtt_isolation.assert_true(replay=prior_receipt AND prior_money=r46_activation.money(),
    'funded request receipt and all monetary history are immutable across activation replay');
  END IF;
 END IF;
 PERFORM r46_mtt_isolation.assert_true((SELECT format_contract='mtt-v1' AND max_players=3 AND buy_in_amount=180 AND buy_in_fee=20
   FROM public.tournaments WHERE id='46462000-0000-4000-8000-000000000003'),'activation does not rewrite funded legacy parent terms');
 RAISE NOTICE 'MTT ACTUAL ACTIVATION TRANSITION COMPLETE: %',p_case;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r46_activation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA r46_activation FROM PUBLIC;
COMMIT;
