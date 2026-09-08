DO $probe$
DECLARE src text; caught boolean; mode text; event uuid:='00000000-0000-4000-8000-000000000001';
 club uuid:='00000000-0000-4000-8000-000000000002';
 union_id uuid:='00000000-0000-4000-8000-000000000003';
BEGIN
 CREATE TEMP TABLE tournaments(id uuid,name text,club_id uuid,union_id uuid,status text,variant text,payout_percent numeric,payout_structure text,prize_pool numeric,guaranteed_prize numeric,satellite_seats integer,satellite_target_id uuid,satellite_target uuid,tournament_type text,is_private boolean,buy_in_amount numeric,buy_in_fee numeric) ON COMMIT DROP;
 CREATE TEMP TABLE tournament_players(tournament_id uuid) ON COMMIT DROP;
 CREATE TEMP TABLE clubs(id uuid,chip_treasury numeric,updated_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE union_wallets(union_id uuid,chip_balance numeric,updated_at timestamptz) ON COMMIT DROP;
 CREATE TEMP TABLE chip_ledger(performed_by uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,club_id uuid,tournament_id uuid,description text) ON COMMIT DROP;
 CREATE TEMP TABLE ca_ledger_write_failures(club_id uuid,user_id uuid,delta numeric,sqlstate text,message text) ON COMMIT DROP;
 CREATE TEMP TABLE probe_fault(mode text) ON COMMIT DROP;
 CREATE TEMP SEQUENCE probe_attempt;
 EXECUTE $f$CREATE FUNCTION pg_temp.probe_uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.fn_raise_server_financial_alert(text,text,text,jsonb,text) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END'$f$;
 EXECUTE $f$CREATE FUNCTION pg_temp.probe_ledger_fault() RETURNS trigger LANGUAGE plpgsql AS $body$
 DECLARE m text; attempt bigint;
 BEGIN
  SELECT mode INTO m FROM pg_temp.probe_fault;
  attempt:=nextval('pg_temp.probe_attempt');
  IF m='journal_error' THEN RAISE EXCEPTION 'injected journal refusal' USING ERRCODE='XX001'; END IF;
  IF m='deadlock_always' OR (m='deadlock_twice' AND attempt<=2) THEN RAISE EXCEPTION 'injected deadlock' USING ERRCODE='40P01'; END IF;
  RETURN NEW;
 END $body$$f$;
 CREATE TRIGGER probe_ledger_failure BEFORE INSERT ON pg_temp.chip_ledger FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_ledger_fault();
 SELECT pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure) INTO src; src:=replace(replace(replace(src,'public.','pg_temp.'),'auth.uid()','pg_temp.probe_uid()'),'SET search_path TO ''public'', ''pg_temp''','SET search_path TO ''pg_temp'''); EXECUTE src;
 CREATE TRIGGER zz_ca_fund_overlay_on_lock BEFORE UPDATE OF status ON pg_temp.tournaments FOR EACH ROW EXECUTE FUNCTION pg_temp.fn_ca_fund_overlay_on_lock();
 INSERT INTO pg_temp.tournaments(id,name,club_id,union_id,status,variant,prize_pool,guaranteed_prize,is_private) VALUES(event,'isolated overlay probe',club,union_id,'REGISTERING','mtt',60,100,false);
 INSERT INTO pg_temp.clubs VALUES(club,100,now());
 INSERT INTO pg_temp.union_wallets VALUES(union_id,100,now());
 INSERT INTO pg_temp.probe_fault VALUES('journal_error');
 FOREACH mode IN ARRAY ARRAY['journal_error','deadlock_always'] LOOP
  -- disambiguate the PL/pgSQL local from the table's column
  EXECUTE 'UPDATE pg_temp.probe_fault SET mode=$1' USING mode;
  PERFORM setval('pg_temp.probe_attempt',1,false);
  caught:=false;
  BEGIN
   UPDATE pg_temp.tournaments SET status='RUNNING' WHERE id=event;
  EXCEPTION WHEN SQLSTATE 'XX001' OR deadlock_detected THEN caught:=true; END;
  IF NOT caught OR (SELECT chip_balance FROM pg_temp.union_wallets)<>100 OR (SELECT chip_treasury FROM pg_temp.clubs)<>100 OR (SELECT status FROM pg_temp.tournaments)<>'REGISTERING' OR (SELECT prize_pool FROM pg_temp.tournaments)<>60 OR EXISTS(SELECT 1 FROM pg_temp.chip_ledger) THEN RAISE EXCEPTION 'FAIL journal failure preserved bank debit or pool publication: mode %, caught %',mode,caught; END IF;
 END LOOP;
 UPDATE pg_temp.probe_fault SET mode='deadlock_twice';
 PERFORM setval('pg_temp.probe_attempt',1,false);
 UPDATE pg_temp.tournaments SET status='RUNNING' WHERE id=event;
 IF (SELECT chip_balance FROM pg_temp.union_wallets)<>60 OR (SELECT prize_pool FROM pg_temp.tournaments)<>100 OR (SELECT sum(amount) FROM pg_temp.chip_ledger)<>40 OR (SELECT count(*) FROM pg_temp.chip_ledger)<>1 OR (SELECT last_value FROM pg_temp.probe_attempt)<>3 THEN RAISE EXCEPTION 'FAIL transient journal retry duplicated funding'; END IF;
 UPDATE pg_temp.tournaments SET status='RUNNING' WHERE id=event;
 IF (SELECT chip_balance FROM pg_temp.union_wallets)<>60 OR (SELECT count(*) FROM pg_temp.chip_ledger)<>1 THEN RAISE EXCEPTION 'FAIL status replay double debit'; END IF;
 -- Existing fallback and private-club routing still fund the actual bank.
 TRUNCATE pg_temp.chip_ledger;
 UPDATE pg_temp.probe_fault SET mode='none';
 UPDATE pg_temp.union_wallets SET chip_balance=20;
 UPDATE pg_temp.clubs SET chip_treasury=100;
 UPDATE pg_temp.tournaments SET status='REGISTERING',prize_pool=60 WHERE id=event;
 UPDATE pg_temp.tournaments SET status='RUNNING' WHERE id=event;
 IF (SELECT chip_balance FROM pg_temp.union_wallets)<>20 OR (SELECT chip_treasury FROM pg_temp.clubs)<>60 OR (SELECT from_type FROM pg_temp.chip_ledger)<>'club_treasury' THEN RAISE EXCEPTION 'FAIL fallback bank routing'; END IF;
 TRUNCATE pg_temp.chip_ledger;
 UPDATE pg_temp.union_wallets SET chip_balance=100;
 UPDATE pg_temp.clubs SET chip_treasury=100;
 UPDATE pg_temp.tournaments SET status='REGISTERING',prize_pool=60,is_private=true WHERE id=event;
 UPDATE pg_temp.tournaments SET status='RUNNING' WHERE id=event;
 IF (SELECT chip_balance FROM pg_temp.union_wallets)<>100 OR (SELECT chip_treasury FROM pg_temp.clubs)<>60 OR (SELECT from_type FROM pg_temp.chip_ledger)<>'club_treasury' THEN RAISE EXCEPTION 'FAIL private bank routing'; END IF;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: actual overlay trigger rolls back bank and pool on journal/refused retries; transient retry funds once; replay, fallback and private routing pass; all rolled back';
END $probe$;
