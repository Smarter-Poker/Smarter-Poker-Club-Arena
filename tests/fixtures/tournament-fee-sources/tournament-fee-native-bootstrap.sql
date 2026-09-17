CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION public.u(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('fixture.engine',true) IS DISTINCT FROM 'false'$$;
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,is_private boolean,tournament_type text);
CREATE TABLE public.rake_records(id uuid PRIMARY KEY,tournament_id uuid,hand_id uuid,is_tournament boolean,club_id uuid,rake_amount numeric,source text,metadata jsonb,player_contributions jsonb,created_at timestamptz,terminal_closed_at timestamptz);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,club_id uuid,registered_at timestamptz);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,club_id uuid,category text,amount numeric,created_at timestamptz);
CREATE TABLE public.tournament_refund_entitlements(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,refund_wallet_club_id uuid,source_ledger_id uuid,created_at timestamptz,gross numeric,refund_fee numeric,entitlement_kind text,charge_category text,registration_id uuid,source_ticket_id uuid,source_satellite_id uuid);
CREATE TABLE public.spin_reserve_ledger(id uuid PRIMARY KEY,tournament_id uuid,kind text,seats integer,house_rake numeric,amount numeric,buy_in numeric);
CREATE TABLE public.union_wallet_transactions(id uuid PRIMARY KEY,union_id uuid,club_id uuid,wallet text,direction text,tx_type text,amount numeric,created_at timestamptz,notes text);
CREATE TABLE public.tournament_unregistration_receipts(tournament_id uuid,user_id uuid,fee_reversal_ids uuid[],fee_source_rake_record_ids uuid[]);
CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY,fee_reversal_ids uuid[],total_rake_after numeric,fees_reversed numeric,total_rake_before numeric);
CREATE TABLE public.agents(id uuid PRIMARY KEY,club_id uuid,user_id uuid,lifetime_rake_generated numeric,weekly_rake_generated numeric,last_active_at timestamptz,updated_at timestamptz);
INSERT INTO agents(id,club_id,user_id) VALUES(u(5021),u(21),u(777)),(u(5022),u(22),u(777)),(u(5023),u(23),u(777));
CREATE TABLE public.agent_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,amount numeric,commission_rate numeric,source_type text,source_id uuid,notes text,created_at timestamptz,UNIQUE(user_id,source_type,source_id));
CREATE TABLE public.agent_commission_settlements(club_id uuid,period_start timestamptz,period_end timestamptz);
CREATE TABLE public.accounting_routed_settlement_runs(union_id uuid,standalone_club_id uuid,period_start timestamptz,period_end timestamptz);
CREATE TABLE public.accounting_period_recompute_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,period_start date,period_end date,status text,reason text,last_result jsonb NOT NULL DEFAULT '{}',last_requested_at timestamptz,UNIQUE(club_id,period_start,period_end));
CREATE TABLE public.vip_probe(player_id uuid,credit numeric,source_type text,source_id uuid,UNIQUE(player_id,source_id));
CREATE FUNCTION public.fn_award_vip_credit(p uuid,r numeric,t text,s uuid,n text) RETURNS void LANGUAGE plpgsql AS $$BEGIN INSERT INTO vip_probe VALUES(p,r,t,s);END$$;
CREATE TABLE public.stats_probe(raw_id uuid,player_id uuid,club_id uuid,credit numeric,UNIQUE(raw_id,player_id));
CREATE FUNCTION public.apply_rakeback_player_stats(raw uuid,p uuid,c uuid,h numeric,r numeric) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('fixture.stats_fail',true)=p::text THEN RAISE EXCEPTION 'injected_stats_failure'; END IF;
 INSERT INTO stats_probe VALUES(raw,p,c,r);
END$$;
CREATE FUNCTION public.fn_union_week_start(t timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',t AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION public.fn_poker_diamond_tournament(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('fixture.diamond',true)='true',false)$$;
-- Shared component is deliberately stubbed: parent owns and independently tests
-- the real observed-history/hierarchy implementation. This fixture proves the
-- precise club/time/amount passed into it and rolls back missing evidence.
CREATE FUNCTION public.fn_accounting_earning_contract(c uuid,p uuid,r numeric,game_union uuid,terms_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$ BEGIN
 IF current_setting('fixture.missing_player',true)=p::text THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('player_id',p,'club_id',c,'rake_credit',r,'union_id',game_union,
  'coordinator_union_id',u(90),'terms_at',terms_at,'membership',jsonb_build_object('history_id',p,'terms',jsonb_build_object('club_id',c,'user_id',p)),
  'tiers',jsonb_build_array(jsonb_build_object('agent_id',(SELECT id FROM agents WHERE club_id=c AND user_id=u(777)),'user_id',u(777),'depth',1,'amount',round(r*0.25,2),'rate',0.25)),
  'club_residual',r-round(r*0.25,2),'union_agreement',jsonb_build_object('history_id',u(999),'terms',jsonb_build_object('rate_spin',0.90)));
 END $$;
CREATE TABLE assertions(name text);
CREATE FUNCTION assert_true(ok boolean,name text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',name; END IF;
 INSERT INTO assertions VALUES(name);RAISE NOTICE 'PASS: %',name;
END$$;
CREATE FUNCTION assert_refuses(source uuid,expected text,name text) RETURNS void LANGUAGE plpgsql AS $$DECLARE message text;BEGIN
 BEGIN PERFORM fn_capture_accounting_tournament_fee(source);EXCEPTION WHEN OTHERS THEN message:=SQLERRM;END;
 PERFORM assert_true(message=expected,name||COALESCE(' ['||message||']',' [unexpected success]'));
END$$;
CREATE FUNCTION fixture_fee(n integer,spin boolean DEFAULT false,fee numeric DEFAULT 1)
RETURNS uuid LANGUAGE plpgsql AS $$DECLARE event uuid:=u(n);raw uuid:=u(n+1);contrib jsonb:='[]'; pc jsonb:='{}'; k int; pl uuid;cl uuid;reg uuid;led uuid;ent uuid;weight numeric;
BEGIN
 INSERT INTO tournaments(id,club_id,union_id,is_private,tournament_type) VALUES(event,u(99),u(90),false,CASE WHEN spin THEN 'SPIN' ELSE 'MTT' END);
 FOR k IN 1..CASE WHEN spin THEN 3 ELSE 1 END LOOP
  pl:=u(n+10+k);cl:=u(20+k);reg:=u(n+20+k);led:=u(n+30+k);ent:=u(n+40+k);weight:=CASE WHEN spin THEN 1 ELSE fee END;
  INSERT INTO tournament_players VALUES(reg,event,pl,cl,transaction_timestamp());
  INSERT INTO chip_ledger(id,from_type,from_entity_id,to_type,to_entity_id,club_id,category,amount,created_at) VALUES(led,'player_wallet',pl,'prize_liability',event,cl,'tournament_buyin',1+fee,transaction_timestamp());
  INSERT INTO tournament_refund_entitlements VALUES(ent,event,pl,cl,led,transaction_timestamp(),1+fee,fee,'wallet_charge','tournament_buyin',NULL,NULL,NULL);
  IF spin THEN UPDATE chip_ledger SET amount=1 WHERE id=led;UPDATE tournament_refund_entitlements SET gross=1,refund_fee=0 WHERE id=ent;END IF;
  contrib:=contrib||jsonb_build_array(jsonb_build_object('player_id',pl,'club_id',cl,'registration_id',reg,'charge_ledger_id',led,'entitlement_id',ent,'charged_at',transaction_timestamp(),'weight',weight));
  pc:=pc||jsonb_build_object(pl,weight);
 END LOOP;
 IF spin THEN INSERT INTO spin_reserve_ledger VALUES(u(n+2),event,'contribution',3,fee,3-fee,1); END IF;
 INSERT INTO rake_records VALUES(raw,event,NULL,true,u(99),fee,CASE WHEN spin THEN 'fn_spin_book_entry' ELSE 'fn_register_horse_for_tournament' END,
  jsonb_build_object('accounting_source_version',2,'kind',CASE WHEN spin THEN 'spin_rake' ELSE 'tournament_entry_fee' END,'user_id',CASE WHEN spin THEN NULL ELSE pl END,'registration_id',reg,
    'accounting_fee_source',jsonb_build_object('union_id',u(90),'game_type',CASE WHEN spin THEN 'spin' ELSE 'mtt' END,'contributors',contrib,'spin_reserve_id',CASE WHEN spin THEN u(n+2) ELSE NULL END)),
  pc,transaction_timestamp(),NULL);
 RETURN raw;
END$$;
