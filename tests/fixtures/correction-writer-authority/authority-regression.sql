\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
SELECT pg_temp.cw_check(current_user='postgres' AND inet_server_addr() IS NULL
 AND current_setting('session_replication_role')='origin','isolated owner setup before actual role probes');
CREATE TEMP TABLE cw_results(label text PRIMARY KEY,request jsonb,result jsonb);
GRANT SELECT,INSERT ON cw_results TO service_role;
-- The snapshot helper is isolated fixture-only; it does not grant access to the
-- private intent relation. Each tested statement still executes as its actual role.
DO $denials$ DECLARE who text;sql_text text;before_book jsonb;q jsonb;BEGIN
 before_book:=pg_temp.cw_book();SELECT request INTO STRICT q FROM correction_fixture_input;
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  PERFORM pg_temp.cw_actor(pg_temp.cw_id(1),who);EXECUTE format('SET LOCAL ROLE %I',who);
  FOREACH sql_text IN ARRAY ARRAY[
   'SELECT * FROM public.ca_correction_request_intents_v1',
   'SELECT request_intent FROM public.ca_correction_request_intents_v1',
   'INSERT INTO public.ca_correction_request_intents_v1(linkage_key,ledger_id,request_intent) VALUES(''fixture-forged'',pg_temp.cw_id(999),''{"version":1}''::jsonb)',
   'UPDATE public.ca_correction_request_intents_v1 SET request_intent=request_intent WHERE false',
   'DELETE FROM public.ca_correction_request_intents_v1 WHERE false',
   'TRUNCATE public.ca_correction_request_intents_v1',
   'SELECT public.ca_correction_intent_immutable_v1()'] LOOP
   BEGIN EXECUTE sql_text;RAISE EXCEPTION 'private correction authority unexpectedly allowed: % / %',who,sql_text;
   EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END LOOP;
  IF who IN('anon','authenticated') THEN
   BEGIN PERFORM pg_temp.cw_call(q);RAISE EXCEPTION 'application correction writer unexpectedly allowed: %',who;
   EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END IF;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.cw_check(pg_temp.cw_book()=before_book,'private access and writer refusal preserve all rows for '||who);
 END LOOP;
END$denials$;
-- A granted membership cannot inherit private access through the standard
-- authenticated role. The isolated synthetic role is removed by ROLLBACK.
CREATE ROLE correction_fixture_inherited NOLOGIN INHERIT;
GRANT authenticated TO correction_fixture_inherited;
DO $inherited$ DECLARE before_book jsonb;BEGIN
 before_book:=pg_temp.cw_book();SET LOCAL ROLE correction_fixture_inherited;
 BEGIN PERFORM request_intent FROM public.ca_correction_request_intents_v1;
  RAISE EXCEPTION 'inherited private intent read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 RESET ROLE;
 PERFORM pg_temp.cw_check(pg_temp.cw_book()=before_book,'inherited application membership does not expose private intent');
END$inherited$;
SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');SET LOCAL ROLE service_role;
DO $service$ DECLARE q jsonb;a jsonb;b jsonb;before_book jsonb;field text;BEGIN
 SELECT request INTO STRICT q FROM correction_fixture_input;before_book:=pg_temp.cw_book();
 FOREACH field IN ARRAY ARRAY[NULL,'NaN','Infinity','-Infinity','0','-1','0.001'] LOOP
  b:=pg_temp.cw_call(q||jsonb_build_object('amount',field,'incident_id',pg_temp.cw_id(999)));
  PERFORM pg_temp.cw_check(b=jsonb_build_object('ok',false,'reason','amount_must_be_positive_cents')
   AND pg_temp.cw_book()=before_book,'invalid amount is refused before nonexistent reference lookup');
 END LOOP;
 SELECT request||jsonb_build_object('incident_id',pg_temp.cw_id(303),'write_failure_id',9636001,
  'reason','Both valid references and the actual first actor are retained privately') INTO STRICT q FROM correction_fixture_input;
 before_book:=pg_temp.cw_book();a:=pg_temp.cw_call(q);
 PERFORM pg_temp.cw_check(a->'ok'='true'::jsonb AND a->'replayed'='false'::jsonb AND a->>'ledger_id' IS NOT NULL,
  'actual service-role first call has authoritative success');
 INSERT INTO cw_results VALUES('both_links',q,a);
 SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;
 before_book:=pg_temp.cw_book();b:=pg_temp.cw_call(q);
 PERFORM pg_temp.cw_check(b=jsonb_build_object('ok',true,'replayed',true,'ledger_id',a->'ledger_id')
  AND pg_temp.cw_book()=before_book,'same actor exact replay preserves all rows and original ledger');
 -- Both alternate references really exist. The write-failure key stays the
 -- same when only the incident changes, so this must reach full-intent refusal.
 b:=pg_temp.cw_call(q||jsonb_build_object('incident_id',pg_temp.cw_id(304)));
 PERFORM pg_temp.cw_check(b=jsonb_build_object('ok',false,'reason','correction_intent_conflict')
  AND pg_temp.cw_book()=before_book,'different valid secondary incident cannot reuse write-failure linkage');
 PERFORM pg_temp.cw_actor(pg_temp.cw_id(2),'service_role');
 b:=pg_temp.cw_call(q);
 PERFORM pg_temp.cw_check(b=jsonb_build_object('ok',false,'reason','correction_intent_conflict')
  AND pg_temp.cw_book()=before_book,'different valid authenticated actor cannot replay first actor intent');
 PERFORM pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');
 b:=pg_temp.cw_call(q||jsonb_build_object('incident_id',pg_temp.cw_id(305),'write_failure_id',9636002));
 PERFORM pg_temp.cw_check(b->'ok'='true'::jsonb AND b->'replayed'='false'::jsonb
  AND b->>'ledger_id' IS DISTINCT FROM a->>'ledger_id','separate real references remain a distinct authorized operation');
 INSERT INTO cw_results VALUES('other_links',q||jsonb_build_object('incident_id',pg_temp.cw_id(305),'write_failure_id',9636002),b);
END$service$;
RESET ROLE;
DO $retained$ DECLARE r record;before_book jsonb;sql_text text;BEGIN
 FOR r IN SELECT * FROM cw_results LOOP
  PERFORM pg_temp.cw_check(EXISTS(SELECT 1 FROM public.ca_correction_request_intents_v1 i
   WHERE i.ledger_id=(r.result->>'ledger_id')::uuid AND i.linkage_key='correction:lwf:'||(r.request->>'write_failure_id')
   AND i.request_intent->>'actor_uid'=pg_temp.cw_id(1)::text
   AND i.request_intent->>'incident_id'=r.request->>'incident_id'
   AND i.request_intent->>'write_failure_id'=r.request->>'write_failure_id'), 'private intent binds both actual references and original actor');
  PERFORM pg_temp.cw_check(EXISTS(SELECT 1 FROM public.accounting_correction_documents d JOIN public.settlement_invoices inv ON inv.id=d.invoice_id
   WHERE d.source_ledger_id=(r.result->>'ledger_id')::uuid AND inv.status='generated' AND inv.chips_transferred=false
   AND d.audience_user_ids=ARRAY[pg_temp.cw_id(2)]), 'actual role writer retains the same record-only payee document');
 END LOOP;
 before_book:=pg_temp.cw_book();
 FOREACH sql_text IN ARRAY ARRAY[
  'UPDATE public.ca_correction_request_intents_v1 SET request_intent=request_intent',
  'DELETE FROM public.ca_correction_request_intents_v1 WHERE false',
  'TRUNCATE public.ca_correction_request_intents_v1'] LOOP
  BEGIN EXECUTE sql_text;RAISE EXCEPTION 'owner intent mutation accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'correction_intent_is_immutable' THEN RAISE;END IF;END;
  PERFORM pg_temp.cw_check(pg_temp.cw_book()=before_book,'statement-level immutable intent blocks owner writes, including zero matched rows');
 END LOOP;
END$retained$;
-- Preserve an actual preexisting incident correction reference. It is not
-- rewritten into a new payment claim when a distinct correction is recorded.
UPDATE public.ca_drift_incidents SET correction_ref='preexisting synthetic repair reference' WHERE id=pg_temp.cw_id(306);
SELECT pg_temp.cw_actor(pg_temp.cw_id(1),'service_role');SET LOCAL ROLE service_role;
DO $reference$ DECLARE q jsonb;r jsonb;book jsonb;BEGIN
 SELECT request||jsonb_build_object('incident_id',pg_temp.cw_id(306)) INTO STRICT q FROM correction_fixture_input;
 r:=pg_temp.cw_call(q);book:=pg_temp.cw_book();
 PERFORM pg_temp.cw_check((r->'ok'='true'::jsonb) IS TRUE AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(book->'public.ca_drift_incidents') j
   WHERE j->>'id'=pg_temp.cw_id(306)::text AND j->>'correction_ref'='preexisting synthetic repair reference'),
  'existing incident reference survives first successor correction');
END$reference$;
RESET ROLE;
CREATE FUNCTION pg_temp.cw_transform_retained() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('cw.fixture_transform',true)=TG_TABLE_NAME THEN
  IF TG_TABLE_NAME='ca_drift_incidents' THEN NEW.correction_ref:='fixture replaced reference';
  ELSIF TG_TABLE_NAME='ca_incident_events' THEN NEW.detail:=NEW.detail||'{"amount":999}'::jsonb;
  ELSE NEW.request_intent:=NEW.request_intent||'{"reason":"fixture replaced full reason"}'::jsonb;END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER fixture_transform_incident BEFORE UPDATE ON public.ca_drift_incidents FOR EACH ROW EXECUTE FUNCTION pg_temp.cw_transform_retained();
CREATE TRIGGER fixture_transform_event BEFORE INSERT ON public.ca_incident_events FOR EACH ROW EXECUTE FUNCTION pg_temp.cw_transform_retained();
CREATE TRIGGER fixture_transform_intent BEFORE INSERT ON public.ca_correction_request_intents_v1 FOR EACH ROW EXECUTE FUNCTION pg_temp.cw_transform_retained();
SET LOCAL ROLE service_role;
DO $transforms$ DECLARE q jsonb;book jsonb;target text;expected text;observed text;BEGIN
 SELECT request INTO STRICT q FROM correction_fixture_input;book:=pg_temp.cw_book();
 FOREACH target IN ARRAY ARRAY['ca_drift_incidents','ca_incident_events','ca_correction_request_intents_v1'] LOOP
  expected:=CASE target WHEN 'ca_drift_incidents' THEN 'correction_incident_reference_mismatch'
   WHEN 'ca_incident_events' THEN 'correction_incident_event_mismatch' ELSE 'correction_intent_retained_mismatch' END;
  observed:=NULL;
  BEGIN
   PERFORM set_config('cw.fixture_transform',target,true);PERFORM pg_temp.cw_call(q);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN observed:=SQLERRM;END;
  PERFORM set_config('cw.fixture_transform','',true);
  PERFORM pg_temp.cw_check(observed=expected AND pg_temp.cw_book()=book,'retained projection transformation refuses and rolls back: '||target);
 END LOOP;
END$transforms$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
