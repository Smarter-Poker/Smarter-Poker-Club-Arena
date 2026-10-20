-- Isolated PG17 qualification of the real aggregate raiser and resolution trigger.
-- No wallet, prize, ledger or provider mutations. Existing connected job owns it.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='15s';
-- Existing core capture predates this installed metadata column. Fixture only.
ALTER TABLE public.ca_drift_incidents ADD COLUMN IF NOT EXISTS closure_basis text;
CREATE FUNCTION pg_temp.storm_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'storm qualification: %',label; END IF; END $$;
-- The surrounding core snapshot predates resolved-on-insert handling. Install
-- the exact current captured bridge, never disable its authentic INSERT trigger.
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_financial_alert_to_incident','qualification exact current bridge');
\ir fixtures/tournament-finish-storm/current-bridge.sql
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','qualification exact current preimage');
\ir fixtures/tournament-finish-storm/preimages.sql
CREATE TEMP TABLE storm_ids(label text PRIMARY KEY,id uuid NOT NULL);
CREATE FUNCTION pg_temp.storm_setup(p_case text DEFAULT 'valid') RETURNS void LANGUAGE plpgsql AS $$
DECLARE a uuid;b uuid;v uuid;
BEGIN
 DELETE FROM storm_ids;
 INSERT INTO ca_drift_incidents(source,dedupe_key) SELECT 'financial_alerts:Tournament.atomic_finish_refused','storm-test-filler:'||n FROM generate_series(1,25)n;
 IF p_case='valid' THEN
  -- Positive cases exercise the authentic INSERT -> bridge -> raiser graph.
  INSERT INTO financial_alerts(severity,source,message,context) VALUES('critical','Tournament.atomic_finish_refused','isolated first refusal',jsonb_build_object('club_id','fade0000-0000-0000-0000-000000000001','tournament_id',gen_random_uuid())) RETURNING id INTO a;
  INSERT INTO financial_alerts(severity,source,message,context) VALUES('critical','Tournament.atomic_finish_refused','isolated second refusal',jsonb_build_object('club_id','fade0000-0000-0000-0000-000000000001','tournament_id',gen_random_uuid())) RETURNING id INTO b;
  SELECT id INTO STRICT v FROM ca_drift_incidents WHERE dedupe_key='storm:financial_alerts:Tournament.atomic_finish_refused' AND status='open';
 ELSE
  -- Negative evidence is supplied at the original raise, never by rewriting
  -- append-only incident events or deleting an original financial record.
  INSERT INTO financial_alerts(severity,source,message,resolved,resolved_at)
   VALUES('critical',CASE WHEN p_case='wrong_source' THEN 'unrelated_source' ELSE 'Tournament.atomic_finish_refused' END,'isolated first refusal',true,now()) RETURNING id INTO a;
  INSERT INTO financial_alerts(severity,source,message,resolved,resolved_at)
   VALUES('critical','Tournament.atomic_finish_refused','isolated second refusal',true,now()) RETURNING id INTO b;
  UPDATE financial_alerts SET resolved=false,resolved_at=NULL WHERE id IN(a,b);
  v:=fn_ca_raise_drift_incident(p_source=>'financial_alerts:Tournament.atomic_finish_refused',p_classification=>'unknown',p_severity=>'critical',p_dedupe_key=>'storm-test-member:first',p_discrepancy=>0,
   p_metadata=>CASE p_case WHEN 'unknown' THEN '{}'::jsonb WHEN 'malformed' THEN '{"alert_id":"not-a-uuid"}'::jsonb WHEN 'missing' THEN jsonb_build_object('alert_id',gen_random_uuid()) ELSE jsonb_build_object('alert_id',a) END);
  PERFORM fn_ca_raise_drift_incident(p_source=>'financial_alerts:Tournament.atomic_finish_refused',p_classification=>'unknown',p_severity=>'critical',p_dedupe_key=>'storm-test-member:second',p_discrepancy=>0,p_metadata=>jsonb_build_object('alert_id',b));
 END IF;
 INSERT INTO storm_ids VALUES('a',a),('b',b),('storm',v);
END $$;
SAVEPOINT before_source;
SELECT pg_temp.storm_setup();
UPDATE financial_alerts SET resolved=true,resolved_at=now(),resolution='Isolated original trigger qualification, no chips moved' WHERE id IN(SELECT id FROM storm_ids WHERE label IN('a','b'));
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'FAIL BEFORE: original trigger leaves fully resolved aggregate open');
ROLLBACK TO before_source;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident','qualification exact storm membership change');
\ir ../../supabase/components/tournament-finish-storm-members.sql
SAVEPOINT final_source;
SELECT pg_temp.storm_setup();
SELECT pg_temp.storm_assert((SELECT metadata->>'storm_member_version'='1' AND NOT metadata?'alert_id' AND occurrences=2 FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'versioned aggregate never pretends to mirror just its first member');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id=(SELECT id FROM storm_ids WHERE label='a');
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'partial resolution remains open');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id=(SELECT id FROM storm_ids WHERE label='b');
SELECT pg_temp.storm_assert((SELECT status='resolved' AND closure_basis='verified_remeasured' AND resolved_at>=detected_at FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'PASS AFTER: last original member closes exact aggregate');
SELECT pg_temp.storm_assert((SELECT count(*)=25 FROM ca_drift_incidents WHERE dedupe_key LIKE 'storm-test-filler:%' AND status='open'),'unrelated existing incidents unchanged');
SELECT pg_temp.storm_assert((SELECT count(*)=2 AND count(DISTINCT detail->>'alert_id')=2 FROM ca_incident_events WHERE incident_id=(SELECT id FROM storm_ids WHERE label='storm') AND kind='recurred'),'exact original member IDs retained');
ROLLBACK TO final_source;
-- Unknown, missing and wrong-source members cannot authorize closure.
SAVEPOINT unknown_member;
SELECT pg_temp.storm_setup('unknown');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id IN(SELECT id FROM storm_ids WHERE label IN('a','b'));
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'unknown member refuses closure');
ROLLBACK TO unknown_member;
SAVEPOINT missing_member;
SELECT pg_temp.storm_setup('missing');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id=(SELECT id FROM storm_ids WHERE label='b');
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'missing member refuses closure');
ROLLBACK TO missing_member;
SAVEPOINT wrong_source;
SELECT pg_temp.storm_setup('wrong_source');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id IN(SELECT id FROM storm_ids WHERE label IN('a','b'));
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'wrong-source member refuses closure');
ROLLBACK TO wrong_source;
SAVEPOINT direct_mirror;
INSERT INTO financial_alerts(severity,source,message,resolved,resolved_at)
VALUES('critical','storm_fixture_direct','isolated direct mirror',true,now());
CREATE TEMP TABLE storm_direct AS SELECT id FROM financial_alerts WHERE source='storm_fixture_direct';
UPDATE financial_alerts SET resolved=false,resolved_at=NULL WHERE id=(SELECT id FROM storm_direct);
INSERT INTO ca_drift_incidents(source,dedupe_key,metadata)
SELECT 'financial_alerts:storm_fixture_direct','storm-fixture-direct',jsonb_build_object('alert_id',id) FROM storm_direct;
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id=(SELECT id FROM storm_direct);
SELECT pg_temp.storm_assert((SELECT status='resolved' FROM ca_drift_incidents WHERE dedupe_key='storm-fixture-direct'),'ordinary direct mirror unchanged');
ROLLBACK TO direct_mirror;
SAVEPOINT malformed_member;
SELECT pg_temp.storm_setup('malformed');
UPDATE financial_alerts SET resolved=true,resolved_at=now() WHERE id IN(SELECT id FROM storm_ids WHERE label IN('a','b'));
SELECT pg_temp.storm_assert((SELECT status='open' FROM ca_drift_incidents WHERE id=(SELECT id FROM storm_ids WHERE label='storm')),'malformed member refuses closure without an exception');
ROLLBACK TO malformed_member;
SELECT pg_temp.storm_assert(NOT EXISTS(SELECT 1 FROM ca_incident_file_failures WHERE occurred_at>=transaction_timestamp()),'no swallowed trigger errors');
SELECT 'STORM_FAIL_BEFORE_PASS_AFTER_AND_MEMBER_BOUNDARIES_PASS';
ROLLBACK;
