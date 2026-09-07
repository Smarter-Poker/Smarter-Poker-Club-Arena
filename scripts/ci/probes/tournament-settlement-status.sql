DO $probe$
DECLARE src text; j jsonb; before_row jsonb; event uuid:='00000000-0000-4000-8000-000000000001';
 player uuid:='00000000-0000-4000-8000-000000000002';
BEGIN
 CREATE TEMP TABLE tournaments(id uuid,name text,club_id uuid,prize_pool numeric,bounty_pool numeric,bounty_pool_paid numeric,status text) ON COMMIT DROP;
 CREATE TEMP TABLE tournament_obligations(id uuid DEFAULT gen_random_uuid(),tournament_id uuid,kind text,place integer,user_id uuid,amount_owed numeric,amount_paid numeric,source text,adjustment_id uuid,updated_at timestamptz,settled_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE ca_manual_adjustments(id uuid,status text,asset text,tournament_id uuid,target_kind text,target_id uuid,amount numeric) ON COMMIT DROP;
 CREATE TEMP TABLE ca_payout_freeze(scope text,cleared_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE ca_settle_sources(source text) ON COMMIT DROP;
 CREATE TEMP TABLE tournament_payouts(tournament_id uuid,position integer,source text,amount numeric) ON COMMIT DROP;
 CREATE TEMP TABLE wallet_transactions(related_entity_id uuid,user_id uuid,type text,category text,amount numeric) ON COMMIT DROP;
 CREATE TEMP TABLE wallet_credit_idempotency(key text PRIMARY KEY) ON COMMIT DROP;
 CREATE TEMP TABLE probe_bank(balance numeric,credited numeric,fail boolean) ON COMMIT DROP;
 INSERT INTO pg_temp.probe_bank VALUES(99.99,0,false);
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_ca_escrow_can_pay(uuid,text,numeric) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''known'',true,''ok'',$3<=balance,''available'',balance,''prize_balance'',balance,''bounty_balance'',0,''fee_balance'',0) FROM pg_temp.probe_bank'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_raise_server_financial_alert(text,text,text,jsonb,text) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text) RETURNS boolean LANGUAGE plpgsql AS $body$
 BEGIN
  IF (SELECT fail FROM pg_temp.probe_bank) THEN RETURN false; END IF;
  INSERT INTO pg_temp.wallet_credit_idempotency VALUES($3);
  UPDATE pg_temp.probe_bank SET balance=balance-$2,credited=credited+$2;
  RETURN true;
 END $body$$f$;
 SELECT pg_get_functiondef('public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure) INTO src; src:=replace(replace(src,'public.','pg_temp.'),'SET search_path TO ''public''','SET search_path TO ''pg_temp'''); EXECUTE src;
 INSERT INTO pg_temp.tournaments VALUES(event,'isolated status probe',gen_random_uuid(),100,0,0,'COMPLETED');
 j:=pg_temp.fn_settle_tournament_obligation(event,'bubble_protection',NULL,player,100,'engine.audit');
 IF j->>'ok' IS DISTINCT FROM 'true' OR (j->>'paid')::numeric IS DISTINCT FROM 99.99 THEN RAISE EXCEPTION 'FAIL partial credit setup %',j; END IF;
 IF j->>'fully_settled' IS DISTINCT FROM 'false' OR (j->>'remaining')::numeric IS DISTINCT FROM .01 OR (j->>'amount_owed')::numeric IS DISTINCT FROM 100 OR (j->>'amount_paid')::numeric IS DISTINCT FROM 99.99 THEN RAISE EXCEPTION 'FAIL partial credit lacks accurate unpaid status %',j; END IF;
 j:=pg_temp.fn_settle_tournament_obligation(event,'bubble_protection',NULL,player,99.99,'engine.audit');
 IF j->>'fully_settled' IS DISTINCT FROM 'false' OR (j->>'remaining')::numeric IS DISTINCT FROM .01 OR (j->>'paid')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL stale smaller replay hides debt %',j; END IF;
 UPDATE pg_temp.probe_bank SET balance=.01;
 j:=pg_temp.fn_settle_tournament_obligation(event,'bubble_protection',NULL,player,100,'engine.audit');
 IF j->>'fully_settled' IS DISTINCT FROM 'true' OR (j->>'remaining')::numeric IS DISTINCT FROM 0 OR (j->>'paid')::numeric IS DISTINCT FROM .01 OR (j->>'amount_paid')::numeric IS DISTINCT FROM 100 THEN RAISE EXCEPTION 'FAIL final cent status %',j; END IF;
 j:=pg_temp.fn_settle_tournament_obligation(event,'bubble_protection',NULL,player,100,'engine.audit');
 IF j->>'fully_settled' IS DISTINCT FROM 'true' OR (j->>'paid')::numeric IS DISTINCT FROM 0 OR (SELECT credited FROM pg_temp.probe_bank)<>100 OR (SELECT count(*) FROM pg_temp.wallet_credit_idempotency)<>2 THEN RAISE EXCEPTION 'FAIL full replay status or duplicate credit %',j; END IF;
 UPDATE pg_temp.probe_bank SET balance=5,fail=true;
 j:=pg_temp.fn_settle_tournament_obligation(event,'bubble_protection',NULL,player,105,'engine.audit');
 IF j->>'ok' IS DISTINCT FROM 'false' OR j->>'refused_reason'<>'credit_refused' OR (SELECT amount_paid FROM pg_temp.tournament_obligations)<>100 THEN RAISE EXCEPTION 'FAIL refusal contract %',j; END IF;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: partial credit, stale smaller replay, last cent, full replay and refusal; actual function with temp credit/bank helpers; rolled back';
END $probe$;
