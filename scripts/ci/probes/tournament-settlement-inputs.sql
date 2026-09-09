DO $probe$
DECLARE src text; r jsonb; before_row jsonb; request_amount numeric; paid_amount numeric; request_kind text; cases integer:=0;
event uuid := '00000000-0000-4000-8000-000000000101';
owner_user uuid := '00000000-0000-4000-8000-000000000102';
other_user uuid := '00000000-0000-4000-8000-000000000103';
BEGIN
CREATE TEMP TABLE tournaments(id uuid,name text,club_id uuid,prize_pool numeric,bounty_pool numeric,bounty_pool_paid numeric,status text) ON COMMIT DROP;
CREATE TEMP TABLE tournament_obligations(id uuid,tournament_id uuid,kind text,place integer,user_id uuid,amount_owed numeric,amount_paid numeric,source text,updated_at timestamptz,adjustment_id uuid,settled_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE ca_manual_adjustments(id uuid,status text,asset text,tournament_id uuid,target_kind text,target_id uuid,amount numeric) ON COMMIT DROP;
CREATE TEMP TABLE ca_payout_freeze(scope text,cleared_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE ca_settle_sources(source text) ON COMMIT DROP;
CREATE TEMP TABLE wallet_credit_idempotency(key text) ON COMMIT DROP;
CREATE TEMP TABLE audit_credits(user_id uuid,amount numeric,key text) ON COMMIT DROP;
EXECUTE $stub$CREATE FUNCTION pg_temp.fn_ca_escrow_can_pay(uuid,text,numeric) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''known'',true,''ok'',true)'$stub$;
EXECUTE $stub$CREATE FUNCTION pg_temp.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text) RETURNS boolean LANGUAGE plpgsql AS 'BEGIN INSERT INTO pg_temp.audit_credits VALUES($1,$2,$3); RETURN true; END;'$stub$;
-- The public function is now a narrow refund gate.  Input validation remains
-- in the durable settlement delegate exercised by this isolated harness.
SELECT pg_get_functiondef(
  'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure)
  INTO src;
src:=replace(src,
  'public.fn_settle_tournament_obligation_before_atomic_batch_gate',
  'pg_temp.fn_settle_tournament_obligation');
EXECUTE replace(src,'public.','pg_temp.');
INSERT INTO pg_temp.tournaments VALUES(event,'isolated audit',event,1000,0,0,'COMPLETED');
INSERT INTO pg_temp.tournament_obligations VALUES(event,event,'place',1,owner_user,100,100,'engine.audit',now(),NULL,now());
FOREACH request_amount IN ARRAY ARRAY[NULL::numeric,'NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric] LOOP
 SELECT to_jsonb(o) INTO before_row FROM pg_temp.tournament_obligations o;
 r:=pg_temp.fn_settle_tournament_obligation(event,'place',1,owner_user,request_amount,'engine.audit');
 IF r->>'ok' IS DISTINCT FROM 'false' OR r->>'refused_reason' IS DISTINCT FROM 'invalid_amount' THEN RAISE EXCEPTION 'FAIL invalid amount % accepted: %',request_amount,r; END IF;
 IF (SELECT to_jsonb(o) FROM pg_temp.tournament_obligations o) IS DISTINCT FROM before_row OR EXISTS(SELECT 1 FROM pg_temp.audit_credits) THEN RAISE EXCEPTION 'FAIL invalid amount mutated payment state'; END IF;
 cases:=cases+1;
END LOOP;
FOREACH request_amount IN ARRAY ARRAY[-1::numeric,-0.001::numeric] LOOP
 r:=pg_temp.fn_settle_tournament_obligation(event,'place',1,owner_user,request_amount,'engine.audit');
 IF r->>'refused_reason' IS DISTINCT FROM 'negative_amount' THEN RAISE EXCEPTION 'FAIL negative amount rounded into an obligation: %',r; END IF;
 cases:=cases+1;
END LOOP;
FOREACH request_kind IN ARRAY ARRAY['place','late_reg_adjustment'] LOOP
 FOREACH paid_amount IN ARRAY ARRAY[0::numeric,-1::numeric] LOOP
  r:=pg_temp.fn_settle_tournament_obligation(event,request_kind,paid_amount::integer,owner_user,100,'engine.audit');
  IF r->>'refused_reason' IS DISTINCT FROM 'invalid_place' THEN RAISE EXCEPTION 'FAIL invalid place accepted: %',r; END IF;
  cases:=cases+1;
 END LOOP;
END LOOP;
FOREACH request_kind IN ARRAY ARRAY['place','late_reg_adjustment'] LOOP
FOREACH paid_amount IN ARRAY ARRAY[50::numeric,100::numeric] LOOP
 UPDATE pg_temp.tournament_obligations SET amount_paid=paid_amount;
 FOREACH request_amount IN ARRAY ARRAY[50::numeric,100::numeric,200::numeric] LOOP
  SELECT to_jsonb(o) INTO before_row FROM pg_temp.tournament_obligations o;
  r:=pg_temp.fn_settle_tournament_obligation(event,request_kind,1,other_user,request_amount,'engine.audit');
  IF r->>'refused_reason' IS DISTINCT FROM 'place_paid_to_another_user' OR r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FAIL incorrect refusal %',r; END IF;
  IF (SELECT to_jsonb(o) FROM pg_temp.tournament_obligations o) IS DISTINCT FROM before_row OR EXISTS(SELECT 1 FROM pg_temp.audit_credits) THEN RAISE EXCEPTION 'FAIL rejected user changed obligation or credited money'; END IF;
  cases:=cases+1;
 END LOOP;
END LOOP;
END LOOP;
UPDATE pg_temp.tournament_obligations SET amount_paid=100;
r:=pg_temp.fn_settle_tournament_obligation(event,'place',1,owner_user,100,'engine.audit');
IF r->>'fully_settled' IS DISTINCT FROM 'true' OR (r->>'paid')::numeric<>0 OR EXISTS(SELECT 1 FROM pg_temp.audit_credits) THEN RAISE EXCEPTION 'FAIL paid owner replay %',r; END IF;
cases:=cases+1;
r:=pg_temp.fn_settle_tournament_obligation(event,'late_reg_adjustment',1,owner_user,130,'engine.audit');
IF r->>'fully_settled' IS DISTINCT FROM 'true' OR (r->>'paid')::numeric<>30 OR (SELECT amount_owed FROM pg_temp.tournament_obligations)<>130 OR (SELECT amount_paid FROM pg_temp.tournament_obligations)<>130 OR (SELECT amount FROM pg_temp.audit_credits WHERE user_id=owner_user) IS DISTINCT FROM 30::numeric THEN RAISE EXCEPTION 'FAIL valid owner topup %',r; END IF;
cases:=cases+1;
r:=pg_temp.fn_settle_tournament_obligation(event,'late_reg_adjustment',1,owner_user,130,'engine.audit');
IF r->>'fully_settled' IS DISTINCT FROM 'true' OR (r->>'paid')::numeric<>0 OR (SELECT count(*) FROM pg_temp.audit_credits)<>1 THEN RAISE EXCEPTION 'FAIL topup replay %',r; END IF;
cases:=cases+1;
RAISE EXCEPTION 'AUDIT_TEST_PASS: % paid-place identity/refusal/replay/topup cases; actual settlement body, mocked credit/escrow helpers, all fixtures rolled back',cases;
END $probe$;
