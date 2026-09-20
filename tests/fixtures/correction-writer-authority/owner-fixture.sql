-- EXECUTABLE FIXTURE SOURCE, UNRUN. Isolated protected database only.
-- Harness must install the exact combined catalog/candidate and create:
-- pg_temp.correction_fixture_input(request jsonb NOT NULL), exactly one row.
-- request: from_type/from_entity/to_type/to_entity/amount/reason/incident_id/
-- write_failure_id/club_id/union_id/metadata; metadata_sql_null optional boolean.
-- Use a real seeded fresh incident and supported bank/wallet endpoints. No
-- synthetic writer/dependency substitutes. Harness supplies actual allowed JWT.
-- All persistent schemas must be inventoried into the snapshot query below;
-- public + smarter_private is the current bounded contract, not universal proof.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.correction_call(q jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_ca_post_correction(q->>'from_type',(q->>'from_entity')::uuid,
 q->>'to_type',(q->>'to_entity')::uuid,(q->>'amount')::numeric,q->>'reason',
 (q->>'incident_id')::uuid,(q->>'write_failure_id')::bigint,
 (q->>'club_id')::uuid,(q->>'union_id')::uuid,
 CASE WHEN (q->>'metadata_sql_null')::boolean IS TRUE THEN NULL ELSE q->'metadata' END)
$$;
CREATE FUNCTION pg_temp.correction_book() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; rows jsonb; book jsonb := '{}'::jsonb;
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','smarter_private') AND c.relkind IN ('r','p')
     AND NOT c.relispartition ORDER BY n.nspname,c.relname
 LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(v ORDER BY v::text),''[]''::jsonb) FROM (SELECT to_jsonb(t) v FROM %I.%I t) x',r.nspname,r.relname) INTO rows;
   book := book || jsonb_build_object(r.nspname||'.'||r.relname,rows);
 END LOOP;
 RETURN book;
END $$;
CREATE FUNCTION pg_temp.correction_suppress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('correction_fixture.suppress',true)=TG_TABLE_NAME THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='chip_ledger' AND current_setting('correction_fixture.transform',true)='amount' THEN
   NEW.amount := NEW.amount + 1;
 END IF;
 IF TG_TABLE_NAME='chip_ledger' AND current_setting('correction_fixture.transform',true)='status' THEN
   NEW.status := 'correction';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fixture_suppress_ledger BEFORE INSERT ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION pg_temp.correction_suppress();
CREATE TRIGGER fixture_suppress_incident BEFORE UPDATE ON public.ca_drift_incidents
 FOR EACH ROW EXECUTE FUNCTION pg_temp.correction_suppress();
CREATE TRIGGER fixture_suppress_event BEFORE INSERT ON public.ca_incident_events
 FOR EACH ROW EXECUTE FUNCTION pg_temp.correction_suppress();
CREATE TRIGGER fixture_suppress_intent BEFORE INSERT ON public.ca_correction_request_intents_v1
 FOR EACH ROW EXECUTE FUNCTION pg_temp.correction_suppress();

DO $$
DECLARE q jsonb; fault_book jsonb; initial_book jsonb; before_book jsonb; a jsonb; b jsonb; target text; expected text;
 observed text; value text; field text; modified jsonb;
BEGIN
 IF (SELECT count(*) FROM pg_temp.correction_fixture_input)<>1 THEN RAISE EXCEPTION 'one input required'; END IF;
 SELECT request INTO q FROM pg_temp.correction_fixture_input;
 IF q->>'incident_id' IS NULL THEN RAISE EXCEPTION 'incident-linked seed required'; END IF;
 before_book := pg_temp.correction_book();
 initial_book := before_book;
 FOREACH target IN ARRAY ARRAY['chip_ledger','ca_drift_incidents','ca_incident_events','ca_correction_request_intents_v1'] LOOP
   expected := CASE target WHEN 'chip_ledger' THEN 'correction_ledger_insert_missing' WHEN 'ca_drift_incidents' THEN 'correction_incident_update_missing'
    WHEN 'ca_incident_events' THEN 'correction_incident_event_missing' ELSE 'correction_intent_insert_missing' END;
   observed := NULL;
   BEGIN
     PERFORM set_config('correction_fixture.suppress',target,true);
     a := pg_temp.correction_call(q);
   EXCEPTION WHEN OTHERS THEN observed := SQLERRM;
   END;
   PERFORM set_config('correction_fixture.suppress','',true);
   IF observed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'wrong suppression outcome: % / %',target,observed; END IF;
   IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'whole-book rollback failed: %',target; END IF;
 END LOOP;
 FOREACH target IN ARRAY ARRAY['amount','status'] LOOP
 observed := NULL;
 BEGIN
   PERFORM set_config('correction_fixture.transform',target,true);
   a := pg_temp.correction_call(q);
 EXCEPTION WHEN OTHERS THEN observed := SQLERRM;
 END;
 PERFORM set_config('correction_fixture.transform','',true);
 IF observed IS DISTINCT FROM 'correction_ledger_projection_mismatch' THEN
   RAISE EXCEPTION 'wrong transformed ledger outcome: %',observed;
 END IF;
 IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'transformed ledger rollback failed'; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY['NaN','Infinity','-Infinity','0','-1','0.001'] LOOP
   a := pg_temp.correction_call(q||jsonb_build_object('amount',value));
   IF a->>'reason' IS DISTINCT FROM 'amount_must_be_positive_cents' THEN RAISE EXCEPTION 'amount accepted: %',value; END IF;
 END LOOP;
 IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'invalid amount mutated book'; END IF;
 -- Roll back successful cases deliberately, including all trigger side effects.
 BEGIN
   q := q || jsonb_build_object('reason',repeat('long reason ',100),'metadata_sql_null',false,'metadata',jsonb_build_object('a',1,'b',2));
   a := pg_temp.correction_call(q);
   IF a->>'ok' IS DISTINCT FROM 'true' OR a->>'replayed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'fresh call not accepted'; END IF;
   before_book := pg_temp.correction_book();
   b := pg_temp.correction_call(q);
   IF b->>'replayed' IS DISTINCT FROM 'true' OR b->>'ledger_id' IS DISTINCT FROM a->>'ledger_id' THEN RAISE EXCEPTION 'replay identity mismatch'; END IF;
   b := pg_temp.correction_call(q||jsonb_build_object('metadata','{"b":2.0,"a":1.0}'::jsonb));
   IF b->>'replayed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'JSONB equivalence refused'; END IF;
   FOREACH field IN ARRAY ARRAY['from_type','to_type','from_entity','to_entity','amount','reason','club_id','union_id','metadata'] LOOP
     modified := q || jsonb_build_object(field,CASE
       WHEN field IN ('from_entity','to_entity','club_id','union_id') THEN to_jsonb('ffffffff-ffff-4fff-8fff-ffffffffffff'::text)
       WHEN field='amount' THEN to_jsonb(((q->>'amount')::numeric+1)::text)
       WHEN field='reason' THEN to_jsonb((q->>'reason')||'tail')
       WHEN field='metadata' THEN '{"posted_via":"forged"}'::jsonb
       ELSE to_jsonb((q->>field)||'_changed') END);
     b := pg_temp.correction_call(modified);
     IF b->>'reason' IS DISTINCT FROM 'correction_intent_conflict' THEN RAISE EXCEPTION 'conflict accepted: %',field; END IF;
   END LOOP;
   FOREACH value IN ARRAY ARRAY['null','{}'] LOOP
     b := pg_temp.correction_call(q||jsonb_build_object('metadata',value::jsonb));
     IF b->>'reason' IS DISTINCT FROM 'correction_intent_conflict' THEN RAISE EXCEPTION 'metadata conflict accepted'; END IF;
   END LOOP;
   b := pg_temp.correction_call(q||jsonb_build_object('metadata_sql_null',true));
   IF b->>'reason' IS DISTINCT FROM 'correction_intent_conflict' THEN RAISE EXCEPTION 'SQL null conflict accepted'; END IF;
   IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'replay changed book'; END IF;
   -- Isolated fault injection only: retain a divergent journal row, call the
   -- real replay path, then roll back the injected divergence as well.
   FOREACH target IN ARRAY ARRAY['status','description'] LOOP
     BEGIN
       IF target='status' THEN
         UPDATE public.chip_ledger SET status='correction' WHERE id=(a->>'ledger_id')::uuid;
       ELSE
         UPDATE public.chip_ledger SET description='fixture divergence' WHERE id=(a->>'ledger_id')::uuid;
       END IF;
       IF NOT FOUND THEN RAISE EXCEPTION 'replay fault injection missing'; END IF;
       fault_book := pg_temp.correction_book();
       observed := NULL;
       BEGIN
         b := pg_temp.correction_call(q);
       EXCEPTION WHEN OTHERS THEN observed := SQLERRM;
       END;
       IF observed IS DISTINCT FROM 'correction_ledger_projection_mismatch' THEN
         RAISE EXCEPTION 'divergent replay accepted: % / %',target,observed;
       END IF;
       IF pg_temp.correction_book() IS DISTINCT FROM fault_book THEN RAISE EXCEPTION 'divergent replay changed book'; END IF;
       RAISE EXCEPTION USING ERRCODE='ZC002',MESSAGE='rollback_fixture_divergence';
     EXCEPTION WHEN SQLSTATE 'ZC002' THEN NULL;
     END;
     IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'divergence rollback failed'; END IF;
   END LOOP;

   RAISE EXCEPTION USING ERRCODE='ZC001',MESSAGE='fixture_success_rollback';
 EXCEPTION WHEN SQLSTATE 'ZC001' THEN NULL;
 END;
 IF pg_temp.correction_book() IS DISTINCT FROM initial_book THEN RAISE EXCEPTION 'successful-case rollback changed book'; END IF;
 -- Independent fresh SQL-NULL origin, after rolling back the object case.
 BEGIN
   q := q || jsonb_build_object('metadata_sql_null',true);
   a := pg_temp.correction_call(q);
   IF a->>'ok' IS DISTINCT FROM 'true' OR a->>'replayed' IS DISTINCT FROM 'false' THEN
     RAISE EXCEPTION 'fresh SQL-null call not accepted';
   END IF;
   before_book := pg_temp.correction_book();
   b := pg_temp.correction_call(q);
   IF b->>'replayed' IS DISTINCT FROM 'true' OR b->>'ledger_id' IS DISTINCT FROM a->>'ledger_id' THEN
     RAISE EXCEPTION 'SQL-null replay mismatch';
   END IF;
   FOREACH value IN ARRAY ARRAY['null','{}'] LOOP
     b := pg_temp.correction_call(q||jsonb_build_object('metadata_sql_null',false,'metadata',value::jsonb));
     IF b->>'reason' IS DISTINCT FROM 'correction_intent_conflict' THEN
       RAISE EXCEPTION 'SQL-null origin conflated with JSON metadata';
     END IF;
   END LOOP;
   IF pg_temp.correction_book() IS DISTINCT FROM before_book THEN RAISE EXCEPTION 'SQL-null replay changed book'; END IF;
   RAISE EXCEPTION USING ERRCODE='ZC003',MESSAGE='rollback_sql_null_origin';
 EXCEPTION WHEN SQLSTATE 'ZC003' THEN NULL;
 END;
 IF pg_temp.correction_book() IS DISTINCT FROM initial_book THEN RAISE EXCEPTION 'SQL-null origin rollback changed book'; END IF;

END $$;
-- Legacy test requires a second isolated fixture seeded by the actual
-- predecessor before candidate installation. It never deletes intent rows.
-- Harness: create pg_temp.correction_legacy_input(request jsonb), one row.
DO $$
DECLARE q jsonb; a jsonb; book jsonb;
BEGIN
 IF (SELECT count(*) FROM pg_temp.correction_legacy_input)<>1 THEN RAISE EXCEPTION 'legacy seed required'; END IF;
 SELECT request INTO q FROM pg_temp.correction_legacy_input;
 book := pg_temp.correction_book();
 a := pg_temp.correction_call(q);
 IF a->>'reason' IS DISTINCT FROM 'legacy_correction_intent_unavailable' THEN RAISE EXCEPTION 'legacy replay not refused'; END IF;
 IF pg_temp.correction_book() IS DISTINCT FROM book THEN RAISE EXCEPTION 'legacy replay changed book'; END IF;
END $$;
ROLLBACK;
