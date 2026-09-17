-- UNRUN. Protected disposable full-catalog fixture only, after the complete
-- weekly-v3 candidate including 161000. Never load this in a live database.
-- The synthetic future source is exclusively permission qualification: it is
-- not a bank receipt, historical reconstruction, eligible payout or rate policy.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='3s';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';

-- No financial behavior; this lets CREATE TRIGGER reach the target table's
-- privilege check rather than fail because a probe function is inaccessible.
-- REFERENCES needs an ordinary table: PostgreSQL forbids a temporary table's
-- foreign key from referencing a permanent table before this permission proof.
CREATE SCHEMA accounting_authority_permission_probe AUTHORIZATION postgres;
GRANT USAGE,CREATE ON SCHEMA accounting_authority_permission_probe TO anon,authenticated,service_role;
CREATE FUNCTION accounting_authority_permission_probe.accept_insert()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;
GRANT EXECUTE ON FUNCTION accounting_authority_permission_probe.accept_insert() TO anon,authenticated,service_role;

DO $authority_regression$
<<authority_regression>>
DECLARE
 player_id uuid:='d0160000-0000-0000-0000-000000000001';
 club_id uuid:='d0160000-0000-0000-0000-000000000002';
 starts date;ends date;earned timestamptz;cutover timestamptz;history_id bigint;terms jsonb;membership jsonb;
 source_id uuid;attribution_id uuid;hand_id uuid;period_id uuid;request_id uuid;
 result jsonb;before_rows jsonb;after_rows jsonb;
 client text;table_name text;target_column text;action record;target regclass;denials integer:=0;attempt integer;
 claims text;error_text text;credit numeric;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'permission fixture requires postgres with actual triggers enabled';END IF;
 IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=authority_regression.club_id)
  OR EXISTS(SELECT 1 FROM auth.users u WHERE u.id=player_id) THEN
  RAISE EXCEPTION 'permission fixture namespace already exists';END IF;
 SELECT starts_at INTO STRICT cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 starts:=(date_trunc('week',greatest(clock_timestamp(),cutover) AT TIME ZONE 'America/Los_Angeles')+interval '14 days')::date;
 ends:=starts+6;
 IF (starts::timestamp AT TIME ZONE 'America/Los_Angeles')<=clock_timestamp()
  OR (starts::timestamp AT TIME ZONE 'America/Los_Angeles')<cutover THEN
  RAISE EXCEPTION 'permission fixture must use a future post-cutover week';END IF;

 -- Only fixture construction bypasses side-effect triggers. Canonical calls,
 -- direct caller probes and their period/certificate writes use normal triggers.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO auth.users(id) VALUES(player_id);
 INSERT INTO public.users(id,username) VALUES(player_id,'permission_probe_161000');
 INSERT INTO public.profiles(id,username,display_name) VALUES(player_id,'permission_probe_161000','Permission Probe');
 INSERT INTO public.clubs(id,name,owner_id,chip_treasury,is_union,union_id,asset)
  VALUES(club_id,'Permission Fixture Only',player_id,0,false,NULL,'chips');
 INSERT INTO public.club_members(club_id,user_id,role,status,is_active,chip_balance,agent_id,player_rakeback_pct)
  VALUES(club_id,player_id,'player','active',true,0,NULL,0.10);
 terms:=jsonb_build_object('club_id',club_id,'user_id',player_id,'agent_id',NULL,
  'is_active',true,'status','active','player_rakeback_pct',0.10);
 INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms)
  VALUES('club_members',club_id::text||':'||player_id::text,club_id,player_id,'INSERT',transaction_timestamp(),terms)
  RETURNING id INTO history_id;
 membership:=jsonb_build_object('history_id',history_id,'observed_at',transaction_timestamp(),'terms',terms);
 PERFORM set_config('session_replication_role','origin',true);

 FOR attempt IN 1..2 LOOP
  source_id:=('d0160000-0000-0000-0000-'||lpad((10+attempt)::text,12,'0'))::uuid;
  attribution_id:=('d0160000-0000-0000-0000-'||lpad((20+attempt)::text,12,'0'))::uuid;
  hand_id:=('d0160000-0000-0000-0000-'||lpad((30+attempt)::text,12,'0'))::uuid;
  earned:=(starts::timestamp AT TIME ZONE 'America/Los_Angeles')+make_interval(hours=>attempt);
  credit:=CASE WHEN attempt=1 THEN 10 ELSE 5 END;
  PERFORM set_config('session_replication_role','replica',true);
  INSERT INTO public.rake_records(id,hand_id,club_id,rake_amount,created_at,is_tournament,metadata,rake_method)
   VALUES(source_id,hand_id,club_id,credit,earned,false,'{"fixture_only":"161000 permissions"}','WEIGHTED_CONTRIBUTED');
  INSERT INTO public.rake_attributions(id,hand_id,player_id,club_id,rake_record_id,rake_amount,weighted_rake_credit,created_at,rake_method)
   VALUES(attribution_id,hand_id,player_id,club_id,source_id,credit,credit,earned,'WEIGHTED_CONTRIBUTED');
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
   VALUES(source_id,hand_id,earned,'permission-fixture-only-'||attempt,'accrued','{"fixture_only":true}');
  INSERT INTO public.accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(source_id,source_id,player_id,club_id,NULL,NULL,earned,credit,
    jsonb_build_object('player_id',player_id,'club_id',club_id,'attribution_id',attribution_id,'rake_credit',credit,
     'union_id',NULL,'coordinator_union_id',NULL,'membership',membership,'tiers','[]'::jsonb));
  PERFORM set_config('session_replication_role','origin',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  IF current_user<>'service_role' OR NOT public.fn_caller_is_engine() THEN
   RAISE EXCEPTION 'canonical request must execute as the actual service role';END IF;
  result:=public.fn_rakeback_recompute_periods(club_id,starts,ends,NULL);
  EXECUTE 'RESET ROLE';
  IF result->>'accounting_version' IS DISTINCT FROM '2' OR result->>'status' IS DISTINCT FROM 'ready'
   OR result->>'written' IS DISTINCT FROM '1' OR result->>'confirmed_players' IS DISTINCT FROM '1'
   OR result->>'request_state' IS DISTINCT FROM 'complete' OR result->>'request_recorded' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'canonical service request did not write a certified period: %',result;END IF;
  IF attempt=1 THEN
   request_id:=(result->>'request_id')::uuid;
   SELECT rp.id INTO STRICT period_id FROM public.rakeback_periods rp
    WHERE rp.club_id=authority_regression.club_id AND rp.user_id=player_id AND rp.period_start=starts AND rp.period_end=ends;
  ELSIF (result->>'request_id')::uuid IS DISTINCT FROM request_id THEN
   RAISE EXCEPTION 'canonical update duplicated its durable request';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.rakeback_periods rp WHERE rp.id=period_id AND rp.status='pending'
    AND rp.rake_generated=CASE WHEN attempt=1 THEN 10 ELSE 15 END
    AND rp.total_rake_paid=rp.rake_generated AND rp.rakeback_rate=0.10
    AND rp.rakeback_amount=CASE WHEN attempt=1 THEN 1 ELSE 1.50 END AND rp.rakeback_earned=rp.rakeback_amount)
   OR (SELECT count(*) FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=authority_regression.period_id)<>attempt
   OR NOT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q WHERE q.id=request_id AND q.status='complete' AND q.attempts=attempt
     AND q.last_result->>'status'='ready' AND q.last_result->>'written'='1') THEN
   RAISE EXCEPTION 'canonical period, certificate or stored request differs from actual write';END IF;
 END LOOP;
 EXECUTE 'SET LOCAL ROLE service_role';
 result:=public.fn_rakeback_recompute_periods(club_id,starts,ends,NULL);
 EXECUTE 'RESET ROLE';
 IF result->>'status' IS DISTINCT FROM 'ready' OR result->>'written' IS DISTINCT FROM '0'
  OR result->>'request_state' IS DISTINCT FROM 'complete' OR (result->>'request_id')::uuid IS DISTINCT FROM request_id
  OR (SELECT count(*) FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=authority_regression.period_id)<>2
  OR NOT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q WHERE q.id=request_id AND q.attempts=3 AND q.status='complete') THEN
  RAISE EXCEPTION 'canonical replay created another period or certificate, or lost acknowledgment';END IF;
 RAISE NOTICE 'permission proof: service canonical INSERT, UPDATE and replay retain exact period/certificate/request receipts';

 SELECT jsonb_build_object('periods',(SELECT jsonb_agg(to_jsonb(rp) ORDER BY rp.id) FROM public.rakeback_periods rp),
  'payouts',(SELECT jsonb_agg(to_jsonb(pp) ORDER BY pp.id) FROM public.rakeback_period_payouts pp)) INTO before_rows;
 FOREACH client IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  claims:=jsonb_build_object('role',client,'sub',player_id)::text;
  PERFORM set_config('request.jwt.claims',claims,true);
  PERFORM set_config('request.jwt.claim.role',client,true);
  PERFORM set_config('request.jwt.claim.sub',player_id::text,true);
  EXECUTE format('SET LOCAL ROLE %I',client);
  IF current_user<>client THEN RAISE EXCEPTION 'SET ROLE did not select actual caller';END IF;
  FOREACH table_name IN ARRAY ARRAY['rakeback_periods','rakeback_period_payouts'] LOOP
   target:=('public.'||table_name)::regclass;
   target_column:=CASE WHEN table_name='rakeback_periods' THEN 'rakeback_amount' ELSE 'payout_amount' END;
   -- Real read execution; existing RLS decides visibility. This is not a claim
   -- that any other user's rows should be visible to these clients.
   EXECUTE format('SELECT id FROM public.%I LIMIT 0',table_name);
   FOR action IN SELECT * FROM (VALUES
    ('INSERT',CASE WHEN table_name='rakeback_periods' THEN
     format('INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rakeback_amount) VALUES(%L,%L,%L,%L,99)',player_id,club_id,starts+7,ends+7)
     ELSE format('INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status) VALUES(%L,%L,%L,15,10,99,''paid'')',period_id,club_id,player_id) END),
    ('UPDATE',format('UPDATE public.%I SET %I=99 WHERE club_id=%L',table_name,target_column,club_id)),
    ('DELETE',format('DELETE FROM public.%I WHERE club_id=%L',table_name,club_id)),
    ('TRUNCATE',format('TRUNCATE TABLE public.%I',table_name)),
    ('REFERENCES',format('CREATE TABLE accounting_authority_permission_probe.reference_probe(id uuid REFERENCES public.%I(id))',table_name)),
    ('TRIGGER',format('CREATE TRIGGER authority_forbidden_trigger BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION accounting_authority_permission_probe.accept_insert()',table_name)),
    ('MAINTAIN',format('REINDEX TABLE public.%I',table_name))
   ) x(privilege_name,sql_text) LOOP
    BEGIN
     EXECUTE action.sql_text;
     RAISE EXCEPTION 'forbidden % unexpectedly succeeded as % on %',action.privilege_name,client,table_name;
    EXCEPTION WHEN insufficient_privilege THEN
     GET STACKED DIAGNOSTICS error_text=MESSAGE_TEXT;
     IF position(table_name in error_text)=0 THEN
      RAISE EXCEPTION 'permission probe failed for another object, not target %: %',table_name,error_text;END IF;
     denials:=denials+1;
    END;
   END LOOP;
   IF has_table_privilege(current_user,target,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR has_any_column_privilege(current_user,target,'INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'caller retains effective table or column authority: %.%',table_name,client;END IF;
  END LOOP;
  FOR action IN SELECT * FROM (VALUES
   ('fn_rakeback_periods_bulk_upsert','SELECT public.fn_rakeback_periods_bulk_upsert(''[{"rakeback_amount":999999}]''::jsonb)'),
   ('fn_create_settlement_period',format('SELECT public.fn_create_settlement_period(%L::uuid,%L::uuid,%L::date,%L::date)',club_id,player_id,starts,ends))
  ) x(function_name,sql_text) LOOP
   BEGIN
    EXECUTE action.sql_text;
    RAISE EXCEPTION 'retired RPC unexpectedly executable: %.%',client,action.function_name;
   EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS error_text=MESSAGE_TEXT;
    IF position(action.function_name in error_text)=0 THEN
     RAISE EXCEPTION 'RPC probe failed after entry or for another object: %',error_text;END IF;
    denials:=denials+1;
   END;
  END LOOP;
  EXECUTE 'RESET ROLE';
 END LOOP;
 IF denials<>48 THEN RAISE EXCEPTION 'expected 48 actual caller denials, observed %',denials;END IF;
 BEGIN
  PERFORM public.fn_rakeback_periods_bulk_upsert('[{"rakeback_amount":999999}]'::jsonb);
  RAISE EXCEPTION 'owner could still call retired bulk writer';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'rakeback_period_bulk_upsert_retired' THEN RAISE;END IF;
 END;
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_rakeback_periods_bulk_upsert' AND status='closed') THEN
  RAISE EXCEPTION 'retired bulk writer still appears approved in the registry';END IF;
 IF md5(pg_get_functiondef('public.fn_create_settlement_period(uuid,uuid,date,date)'::regprocedure))<>'3ff2d628a4561939095d2c6c0181fba8'
  OR md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))<>'dbeadf42b4143e11c6e7b76343fecf0a' THEN
  RAISE EXCEPTION 'authority closure rewrote the factory or canonical request body';END IF;
 SELECT jsonb_build_object('periods',(SELECT jsonb_agg(to_jsonb(rp) ORDER BY rp.id) FROM public.rakeback_periods rp),
  'payouts',(SELECT jsonb_agg(to_jsonb(pp) ORDER BY pp.id) FROM public.rakeback_period_payouts pp)) INTO after_rows;
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'denied callers changed period/payment rows';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=authority_regression.club_id AND c.chip_treasury=0)
  OR NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=authority_regression.club_id AND m.user_id=player_id AND m.chip_balance=0)
  OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts p WHERE p.club_id=authority_regression.club_id)
  OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.club_id=authority_regression.club_id)
  OR EXISTS(SELECT 1 FROM public.rakeback_periods p WHERE p.club_id=authority_regression.club_id AND (p.status<>'pending' OR p.paid_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'permission fixture unexpectedly posted a payment';END IF;
 RAISE NOTICE 'permission proof: 48 actual client denials, owner bulk refusal, unchanged history, no payment';
END $authority_regression$;
ROLLBACK;
