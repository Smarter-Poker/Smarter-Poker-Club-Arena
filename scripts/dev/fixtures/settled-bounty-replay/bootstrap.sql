-- Reuse the captured table shapes, lane and marker triggers. No production rows.
\ir ../mystery-bust-phase/schema.sql
\ir ../mystery-bust-phase/functions.sql
CREATE TABLE public.clubs(id uuid PRIMARY KEY,asset text,is_platform boolean,union_id uuid);
ALTER TABLE public.tournaments ADD COLUMN club_id uuid;
\ir current-functions.sql
-- A replay must never enter a payer. This explicit test trap is NOT a wallet.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,p_kind text,p_place integer,p_user_id uuid,p_amount numeric,
  p_source text,p_description text DEFAULT NULL,p_adjustment_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'replay entered financial payer';
END $$;
CREATE FUNCTION public.fixture_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
-- Synthetic fully settled receipt, plus a later watermark. All state is local.
CREATE FUNCTION public.fixture_replay_case(asset text DEFAULT 'chips',split boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t uuid:=gen_random_uuid(); tb uuid:=gen_random_uuid(); cl uuid:=gen_random_uuid();
  e uuid:=gen_random_uuid(); a uuid:='a0000000-0000-4000-8000-000000000001';
  b uuid:='b0000000-0000-4000-8000-000000000001'; o uuid:=gen_random_uuid();
  later uuid:=gen_random_uuid(); head numeric:=CASE WHEN asset='diamonds' THEN 5 ELSE 5.01 END;
  share numeric; added numeric; claimants jsonb; u uuid; i integer:=0; n integer:=CASE WHEN split THEN 2 ELSE 1 END;
BEGIN
  INSERT INTO clubs VALUES(cl,asset,true,NULL);
  INSERT INTO tournaments(id,name,status,is_bounty,is_pko,bounty_amount,bounty_pool,bounty_pool_paid,club_id)
    VALUES(t,'Synthetic replay','RUNNING',true,true,head,100,0,cl);
  INSERT INTO tables(id,tournament_id,current_players) VALUES(tb,t,3);
  claimants:=jsonb_build_array(jsonb_build_object('user_id',a,'weight',1));
  IF split THEN claimants:=claimants||jsonb_build_object('user_id',b,'weight',1); END IF;
  INSERT INTO tournament_bounty_obligations(id,tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,mode,head_amount,knocker_user_id,claimants,state,settled_at)
    VALUES(o,t,e,tb,gen_random_uuid(),3000001,now(),now()-interval '1 hour',3,0,0,'pko',head,a,claimants,'settled',now());
  INSERT INTO tournament_bounty_obligations(id,tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,mode,head_amount,knocker_user_id,claimants,state,settled_at)
    VALUES(later,t,gen_random_uuid(),tb,gen_random_uuid(),3000002,now(),now()-interval '1 hour',2,0,0,'pko',5,a,
           jsonb_build_array(jsonb_build_object('user_id',a,'weight',1)),'settled',now());
  INSERT INTO tournament_pko_settlement_watermarks VALUES(t,3000002,later,now());
  FOR u IN SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(claimants) x LOOP
    i:=i+1;
    share:=CASE WHEN n=1 THEN head WHEN i=1 THEN CASE WHEN asset='diamonds' THEN 2 ELSE 2.50 END
                ELSE head-CASE WHEN asset='diamonds' THEN 2 ELSE 2.50 END END;
    added:=share-CASE WHEN asset='diamonds' THEN floor(share/2) ELSE floor(share*100/2)/100 END;
    INSERT INTO tournament_players(tournament_id,user_id,username,chips,status,current_bounty,table_id,seat_number)
      VALUES(t,u,'Synthetic claimant',1000,'playing',head+added,tb,i);
    INSERT INTO tournament_bounties(tournament_id,eliminated_player_id,collector_player_id,bounty_amount,
      added_to_collector_bounty,bounty_obligation_id) VALUES(t,e,u,share,added,o);
    INSERT INTO wallet_transactions(user_id,amount,type,category,related_entity_id)
      VALUES(u,share-added,'credit','bounty',t);
  END LOOP;
  UPDATE tournaments SET bounty_pool_paid=(SELECT sum(amount) FROM wallet_transactions WHERE related_entity_id=t) WHERE id=t;
  PERFORM fixture_assert(fn_bounty_obligation_has_complete_marker(o),'synthetic receipt satisfies actual marker');
  RETURN o;
END $$;
CREATE FUNCTION public.fixture_financial_snapshot(t uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'players',(SELECT jsonb_agg(to_jsonb(x) ORDER BY user_id) FROM tournament_players x WHERE tournament_id=t),
 'markers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounties x WHERE tournament_id=t),
 'wallet',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM wallet_transactions x WHERE related_entity_id=t),
 'obligations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tournament_bounty_obligations x WHERE tournament_id=t),
 'event',(SELECT to_jsonb(x) FROM tournaments x WHERE id=t)); $$;
