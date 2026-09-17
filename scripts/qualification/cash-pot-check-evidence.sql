-- SOURCE ONLY / UNRUN. psql source for a separately admitted, disposable PG17
-- allocation. This input guard is NOT an approval or cleanup receipt.
\set ON_ERROR_STOP on
\if :{?approved_execution_uuid}
\else
  \echo 'approved_execution_uuid is required from the protected executor'
  \quit 3
\endif
BEGIN;
SELECT set_config('cash_qualification.execution_uuid', :'approved_execution_uuid', true);
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
SET LOCAL timezone='UTC';
DO $admission$
DECLARE v_uuid uuid;
BEGIN
  v_uuid:=current_setting('cash_qualification.execution_uuid')::uuid;
  IF v_uuid IS NULL OR current_user<>'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_database()<>'qual_cash_'||replace(v_uuid::text,'-','')
    OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
    OR to_regnamespace('cash_qualification') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))<>3 THEN
    RAISE EXCEPTION 'cash qualification requires approved fresh local PG17 allocation';
  END IF;
END $admission$;
\ir fixtures/cash-pot-check-evidence/preimage.sql
\ir fixtures/cash-pot-check-evidence/original-40538.sql
DO $baseline$
BEGIN
  PERFORM cash_qualification.assert_true(
    md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure))
      ='484ca087624199de5a28678a2799ff75','literal installed baseline');
  EXECUTE replace(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure),
    'CREATE OR REPLACE FUNCTION public.fn_cash_pot_conservation_check(',
    'CREATE OR REPLACE FUNCTION cash_qualification.baseline(');
END $baseline$;
-- Actual baseline body, with only namespace/name changed. Its financial writes
-- roll back via a private sentinel; a real baseline error is never swallowed.
CREATE FUNCTION cash_qualification.baseline_result(p_hours integer) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE v_result jsonb;
BEGIN
  BEGIN
    v_result:=cash_qualification.baseline(p_hours);
    RAISE SQLSTATE 'ZC001';
  EXCEPTION WHEN SQLSTATE 'ZC001' THEN RETURN v_result;
  END;
END $f$;
\ir ../../supabase/components/cash-pot-check-evidence.sql
-- Same exact source replay must validate both complete schemas and body.
\ir ../../supabase/components/cash-pot-check-evidence.sql
CREATE TEMP TABLE qualified_bodies AS
SELECT pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure) candidate,
       pg_get_functiondef('public.fn_ca_cash_pot_evidence_append_only()'::regprocedure) guard;
CREATE TEMP TABLE preserved_financial AS SELECT to_jsonb(f) row_data FROM public.financial_alerts f;
CREATE TEMP TABLE case_result(name text PRIMARY KEY,result jsonb);

-- The actual historical 600-chip sample is UNKNOWN. These fresh UUIDs are
-- synthetic hands only, proving future evidence retention beside that old row.
INSERT INTO public.hand_history(id,table_id,hand_number,created_at,pot_size,rake_amount,bbj_amount,winners)
SELECT ('c4053800-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
 'c4053800-1111-4000-8000-000000000001',g,now()-interval '1 hour',
 CASE WHEN g=1 THEN 600 ELSE 1 END,0,0,'[]'::jsonb FROM generate_series(1,21) g;
INSERT INTO case_result VALUES('baseline21',cash_qualification.baseline_result(24));
INSERT INTO case_result VALUES('candidate21',public.fn_cash_pot_conservation_check(24));
SELECT cash_qualification.assert_true(
 (SELECT result FROM case_result WHERE name='baseline21')=
 (SELECT result FROM case_result WHERE name='candidate21'),'legacy result equality');
SELECT cash_qualification.assert_true(
 (SELECT jsonb_agg(row_data ORDER BY row_data::text) FROM preserved_financial)=
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY to_jsonb(f)::text) FROM public.financial_alerts f),
 'dedupe leaves original financial bytes unchanged');
SELECT cash_qualification.assert_true(
 (SELECT count(*)=1 AND min(anomaly_rows)=21 FROM public.ca_cash_pot_check_evidence)
 AND (SELECT count(*)=21 FROM public.ca_cash_pot_check_anomalies)
 AND (SELECT count(*)=1 AND bool_and(payload->>'preview_count'='20'
   AND payload->>'preview_omitted_count'='1' AND payload->>'stored_omitted_count'='0'
   AND payload->>'financial_alert_id'='33f6a110-4591-4ce7-a249-6311e0584f9b'
   AND payload->>'condition_amount' IN ('620','620.00')
   AND event_key=(payload->>'check_id')||':no_winner_recorded'
   AND severity='warning' AND status='firing')
 FROM public.operational_alert_events),'complete21 and bounded20 exact original link');
SELECT cash_qualification.assert_true(
 NOT EXISTS((SELECT id FROM public.hand_history EXCEPT SELECT hand_id FROM public.ca_cash_pot_check_anomalies)
 UNION ALL (SELECT hand_id FROM public.ca_cash_pot_check_anomalies EXCEPT SELECT id FROM public.hand_history)),
 'all positive hand identities preserved exactly');
SELECT cash_qualification.assert_true(
 NOT EXISTS(SELECT 1 FROM public.ca_cash_pot_check_evidence h
 WHERE h.detail_bytes<>octet_length(convert_to(h.anomalies::text,'UTF8'))
 OR h.header_bytes<>octet_length(convert_to(h.summary::text,'UTF8'))
 OR h.evidence_bytes<>h.header_bytes+h.detail_bytes),'header/detail byte reconciliation');
SELECT cash_qualification.expect_error('UPDATE public.ca_cash_pot_check_evidence SET summary=summary','cash_pot_check_evidence_is_immutable');
SELECT cash_qualification.expect_error('DELETE FROM public.ca_cash_pot_check_anomalies','cannot delete from view','55000');
SELECT cash_qualification.expect_error('TRUNCATE public.ca_cash_pot_check_evidence CASCADE','cash_pot_check_evidence_is_immutable');
SELECT cash_qualification.expect_error(
 'INSERT INTO public.ca_cash_pot_check_anomalies SELECT * FROM public.ca_cash_pot_check_anomalies LIMIT 1',
 'cannot insert into view','55000');
SET LOCAL ROLE service_role;
DO $read_authority$
BEGIN
 IF (SELECT count(*) FROM public.ca_cash_pot_check_evidence)<>1
    OR (SELECT count(*) FROM public.ca_cash_pot_check_anomalies)<>21 THEN
   RAISE EXCEPTION 'service role must read the complete header and typed view';
 END IF;
END $read_authority$;
RESET ROLE;
SELECT cash_qualification.assert_true(
 NOT has_table_privilege('service_role','public.ca_cash_pot_check_evidence','INSERT')
 AND NOT has_table_privilege('service_role','public.ca_cash_pot_check_anomalies','UPDATE')
 AND NOT has_table_privilege('anon','public.ca_cash_pot_check_evidence','SELECT')
 AND NOT has_table_privilege('authenticated','public.ca_cash_pot_check_anomalies','SELECT')
 AND NOT has_function_privilege('anon','public.fn_cash_pot_conservation_check(integer)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_cash_pot_conservation_check(integer)','EXECUTE'),
 'read-only privileged evidence; ordinary roles denied');

-- The detail surface is a typed read-only view, with no FK mode coupling.
SELECT cash_qualification.assert_true(
 (SELECT bool_and(payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca')
 FROM public.operational_alert_events),'every receipt belongs to the requested task');
SELECT cash_qualification.assert_true(
 NOT EXISTS(SELECT 1 FROM public.operational_alert_events e WHERE e.payload->'preview' IS DISTINCT FROM
   (SELECT jsonb_agg(to_jsonb(s)-'check_id'-'evidence_bytes' ORDER BY created_at,hand_id)
    FROM (SELECT d.* FROM public.ca_cash_pot_check_anomalies d
      WHERE d.check_id=(e.payload->>'check_id')::uuid
        AND d.condition_kind=e.payload->>'condition_kind'
      ORDER BY created_at,hand_id LIMIT 20) s)),
 'literal preview order is created_at,hand_id');
SAVEPOINT case_immediate;
CREATE TABLE cash_qualification.mode_parent(id integer PRIMARY KEY);
CREATE TABLE cash_qualification.mode_child(id integer REFERENCES cash_qualification.mode_parent(id) DEFERRABLE INITIALLY DEFERRED);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT cash_qualification.assert_true(
 public.fn_cash_pot_conservation_check(24)=cash_qualification.baseline_result(24),
 'candidate and baseline succeed with ALL IMMEDIATE');
SELECT cash_qualification.assert_true((SELECT count(*)=2 FROM public.ca_cash_pot_check_evidence)
 AND (SELECT count(*)=42 FROM public.ca_cash_pot_check_anomalies)
 AND (SELECT count(*)=2 FROM public.operational_alert_events),'immediate mode complete observation');
SELECT cash_qualification.expect_error('INSERT INTO cash_qualification.mode_child VALUES(1)',
 'mode_child_id_fkey','23503');
-- The unrelated sentinel still fires at INSERT, proving no hidden ALL DEFERRED.
ROLLBACK TO case_immediate;

-- Native guard-only structural cases use a copy of a real candidate-produced
-- record. They are not invented historical40538 hands or payment claims.
CREATE FUNCTION cash_qualification.insert_guard_copy(p_variant text,p_total_bytes integer DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE h public.ca_cash_pot_check_evidence%ROWTYPE; j jsonb; a jsonb:='[]'; n integer:=0; pad integer;
BEGIN
 SELECT * INTO STRICT h FROM public.ca_cash_pot_check_evidence ORDER BY created_at LIMIT 1;
 h.check_id:=gen_random_uuid();
 FOR j IN SELECT value FROM jsonb_array_elements(h.anomalies) LOOP
  n:=n+1;
  j:=(j-'evidence_bytes')||jsonb_build_object('check_id',h.check_id);
  IF p_variant='duplicate_hand' AND n=2 THEN j:=jsonb_set(j,'{hand_id}',h.anomalies->0->'hand_id'); END IF;
  IF p_variant='bad_ordinal' AND n=2 THEN j:=jsonb_set(j,'{ordinal}','1'::jsonb); END IF;
  IF p_variant='missing_key' AND n=1 THEN j:=j-'table_id'; END IF;
  j:=j||jsonb_build_object('evidence_bytes',octet_length(convert_to(j::text,'UTF8')));
  a:=a||jsonb_build_array(j);
 END LOOP;
 h.anomalies:=a;
 h.summary:=jsonb_set(h.summary,'{check_id}',to_jsonb(h.check_id));
 IF p_variant='bad_count' THEN h.summary:=jsonb_set(h.summary,'{result,no_winner_recorded}','999'::jsonb); END IF;
 h.detail_bytes:=octet_length(convert_to(h.anomalies::text,'UTF8'));
 IF p_total_bytes IS NOT NULL THEN
  h.summary:=h.summary||jsonb_build_object('qualification_padding','');
  pad:=p_total_bytes-h.detail_bytes-octet_length(convert_to(h.summary::text,'UTF8'));
  PERFORM cash_qualification.assert_true(pad>=0,'guard-only boundary padding fits');
  h.summary:=jsonb_set(h.summary,'{qualification_padding}',to_jsonb(repeat('x',pad)));
 END IF;
 h.header_bytes:=octet_length(convert_to(h.summary::text,'UTF8'));
 INSERT INTO public.ca_cash_pot_check_evidence(check_id,schema_version,source_contract,summary,anomalies,anomaly_rows,detail_bytes,header_bytes)
 VALUES(h.check_id,h.schema_version,h.source_contract,h.summary,h.anomalies,h.anomaly_rows,h.detail_bytes,h.header_bytes);
 RETURN h.check_id;
END $f$;
SELECT cash_qualification.expect_error($q$SELECT cash_qualification.insert_guard_copy('duplicate_hand')$q$,'cash_pot_check_evidence_header_mismatch');
SELECT cash_qualification.expect_error($q$SELECT cash_qualification.insert_guard_copy('bad_ordinal')$q$,'cash_pot_check_evidence_detail_mismatch');
SELECT cash_qualification.expect_error($q$SELECT cash_qualification.insert_guard_copy('missing_key')$q$,'cash_pot_check_evidence_detail_mismatch');
SELECT cash_qualification.expect_error($q$SELECT cash_qualification.insert_guard_copy('bad_count')$q$,'cash_pot_check_evidence_header_mismatch');
SAVEPOINT case_exact_stored_cap;
SELECT cash_qualification.insert_guard_copy('unchanged',8388608);
SELECT cash_qualification.assert_true(EXISTS(
 SELECT 1 FROM public.ca_cash_pot_check_evidence WHERE evidence_bytes=8388608
 AND evidence_bytes=octet_length(convert_to(summary::text,'UTF8'))+octet_length(convert_to(anomalies::text,'UTF8'))),
 'exact8MiB complete storage boundary accepted');
SELECT cash_qualification.expect_error($q$SELECT cash_qualification.insert_guard_copy('unchanged',8388609)$q$,
 'cash_pot_check_evidence_array_mismatch');
SELECT cash_qualification.assert_true((SELECT count(*)=2 FROM public.ca_cash_pot_check_evidence),
 '8MiB plus1 rejected without partial complete row');
ROLLBACK TO case_exact_stored_cap;

SAVEPOINT case_boundary;
TRUNCATE public.hand_history;
-- NULL/default and clamps, whole-pot jackpot, exact threshold, all JSON shapes,
-- overaward signed negative, lower-inclusive and future timestamps, exclusions.
INSERT INTO public.hand_history(id,table_id,hand_number,created_at,tournament_id,pot_size,rake_amount,bbj_amount,winners)
SELECT ('c4053801-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,NULL,NULL,
 CASE WHEN g=15 THEN now()-interval '48 hours' WHEN g=16 THEN now()-interval '48 hours 1 microsecond'
      WHEN g=17 THEN now()+interval '1 day' ELSE now() END,
 CASE WHEN g=18 THEN 'c4053801-1111-4000-8000-000000000018'::uuid ELSE NULL END,
 CASE WHEN g=19 THEN 0 ELSE 1 END,0,CASE WHEN g=1 THEN 1 ELSE 0 END,
 CASE g WHEN 1 THEN '[]' WHEN 2 THEN '[{"amount":0.99}]'
 WHEN 3 THEN '[{"amount":0.98}]' WHEN 4 THEN '[{"amount":1.02}]'
 WHEN 5 THEN NULL WHEN 6 THEN 'null' WHEN 7 THEN '{}' WHEN 8 THEN '"value"'
 WHEN 9 THEN '2' WHEN 10 THEN 'true' WHEN 11 THEN '[]'
 WHEN 12 THEN '[{}]' WHEN 13 THEN '[{"amount":null}]'
 WHEN 14 THEN '[{"amount":0.5},{"amount":0.5}]'
 ELSE '[]' END::jsonb FROM generate_series(1,19) g;
DO $cases$
DECLARE v_hours integer; v_before bigint; v_after bigint; v_expected jsonb; v_actual jsonb;
BEGIN
  FOREACH v_hours IN ARRAY ARRAY[NULL,0,1,24,48,99]::integer[] LOOP
    v_expected:=cash_qualification.baseline_result(v_hours);
    v_actual:=public.fn_cash_pot_conservation_check(v_hours);
    PERFORM cash_qualification.assert_true(v_actual=v_expected,'edge result equivalence hours='||coalesce(v_hours::text,'NULL'));
  END LOOP;
  PERFORM cash_qualification.assert_true(
    (SELECT count(*)=0 FROM public.ca_cash_pot_check_anomalies WHERE hand_id IN
      ('c4053801-0000-4000-8000-000000000001','c4053801-0000-4000-8000-000000000002',
       'c4053801-0000-4000-8000-000000000014','c4053801-0000-4000-8000-000000000016',
       'c4053801-0000-4000-8000-000000000018','c4053801-0000-4000-8000-000000000019')),
    'jackpot exactthreshold conserved old tournament zero excluded');
  PERFORM cash_qualification.assert_true(
    EXISTS(SELECT 1 FROM public.ca_cash_pot_check_anomalies WHERE hand_id='c4053801-0000-4000-8000-000000000004'
      AND signed_residual=-0.02 AND absolute_residual=0.02)
    AND EXISTS(SELECT 1 FROM public.ca_cash_pot_check_anomalies WHERE hand_id='c4053801-0000-4000-8000-000000000015')
    AND EXISTS(SELECT 1 FROM public.ca_cash_pot_check_anomalies WHERE hand_id='c4053801-0000-4000-8000-000000000017'),
    'overaward not called missing payment; inclusive lower and no new upper bound');
END $cases$;
ROLLBACK TO case_boundary;

SAVEPOINT case_healthy;
TRUNCATE public.hand_history;
CREATE TEMP TABLE before_healthy AS SELECT
 (SELECT count(*) FROM public.ca_cash_pot_check_evidence) h,
 (SELECT count(*) FROM public.operational_alert_events) q,
 (SELECT count(*) FROM public.financial_alerts) f;
SELECT cash_qualification.assert_true(
 public.fn_cash_pot_conservation_check(24)=cash_qualification.baseline_result(24),'healthy result equality');
SELECT cash_qualification.assert_true(
 (SELECT h=(SELECT count(*) FROM public.ca_cash_pot_check_evidence)
   AND q=(SELECT count(*) FROM public.operational_alert_events)
   AND f=(SELECT count(*) FROM public.financial_alerts) FROM before_healthy),
 'healthy check creates no evidence, financial or operational work');
ROLLBACK TO case_healthy;

SAVEPOINT case_timezone;
SET LOCAL timezone='America/Chicago';
SELECT public.fn_cash_pot_conservation_check();
SELECT cash_qualification.assert_true(EXISTS(
 SELECT 1 FROM public.ca_cash_pot_check_evidence WHERE summary->>'serialization_timezone'='America/Chicago'),
 'native non-UTC byte guard is usable');
ROLLBACK TO case_timezone;

SAVEPOINT case_invalid;
UPDATE public.hand_history SET winners='[{"amount":"not-numeric"}]'::jsonb
 WHERE hand_number=1;
SELECT cash_qualification.expect_error('SELECT cash_qualification.baseline_result(24)','invalid input syntax','22P02');
SELECT cash_qualification.expect_error('SELECT public.fn_cash_pot_conservation_check(24)','invalid input syntax','22P02');
SELECT cash_qualification.assert_true((SELECT count(*)=1 FROM public.ca_cash_pot_check_evidence)
 AND (SELECT count(*)=21 FROM public.ca_cash_pot_check_anomalies),'invalid numeric leaves no partial evidence');
ROLLBACK TO case_invalid;

SAVEPOINT case_ratecap;
DELETE FROM public.financial_alerts;
INSERT INTO public.financial_alerts(severity,source,message,context,resolved)
SELECT 'warning','fn_cash_pot_conservation_check','synthetic recent ratecap',
 '{"channel":"server_rpc"}',true FROM generate_series(1,60);
SELECT public.fn_cash_pot_conservation_check();
SELECT cash_qualification.assert_true(
 EXISTS(SELECT 1 FROM public.operational_alert_events WHERE payload->>'financial_link_outcome'='rpc_returned_null'
 AND payload->'financial_alert_id'='null'::jsonb)
 AND (SELECT count(*)=60 FROM public.financial_alerts),
 'ratecap null is explicit; positive hand evidence still complete');
ROLLBACK TO case_ratecap;

SAVEPOINT case_rowlimit;
TRUNCATE public.hand_history;
INSERT INTO public.hand_history(id,created_at,pot_size,rake_amount,bbj_amount,winners)
SELECT ('c4053802-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,now(),1,0,0,'[]'
 FROM generate_series(1,10000) g;
SELECT public.fn_cash_pot_conservation_check();
SELECT cash_qualification.assert_true(EXISTS(
 SELECT 1 FROM public.ca_cash_pot_check_evidence h WHERE h.anomaly_rows=10000
 AND (SELECT count(*) FROM public.ca_cash_pot_check_anomalies d WHERE d.check_id=h.check_id)=10000),
 '10000 admitted identities complete');
CREATE TEMP TABLE before_overflow AS SELECT count(*) h,sum(anomaly_rows) d,
 (SELECT count(*) FROM public.operational_alert_events) q,
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.financial_alerts f) f
 FROM public.ca_cash_pot_check_evidence;
INSERT INTO public.hand_history VALUES('c4053802-0000-4000-8000-000000010001',NULL,NULL,now(),NULL,1,0,0,'[]');
INSERT INTO case_result VALUES('row_limit_error',cash_qualification.expect_error(
 'SELECT public.fn_cash_pot_conservation_check()','cash_pot_check_evidence_limit','54000'));
SELECT cash_qualification.assert_true(
 (SELECT (result->>'detail')::jsonb->>'limit_kind'='anomaly_rows'
   AND (result->>'detail')::jsonb->>'observed_lower_bound'='10001'
   AND ((result->>'detail')::jsonb->>'check_id')::uuid IS NOT NULL
   FROM case_result WHERE name='row_limit_error')
 AND (SELECT h=(SELECT count(*) FROM public.ca_cash_pot_check_evidence)
   AND d=(SELECT sum(anomaly_rows) FROM public.ca_cash_pot_check_evidence)
   AND q=(SELECT count(*) FROM public.operational_alert_events)
   AND f IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.financial_alerts f)
   FROM before_overflow),
 '10001 fails with own invocation and no false complete receipt');
ROLLBACK TO case_rowlimit;

SAVEPOINT case_byte_limit;
TRUNCATE public.hand_history;
CREATE TEMP TABLE before_byte_overflow AS SELECT
 (SELECT count(*) FROM public.operational_alert_events) q,
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.financial_alerts f) f;
-- Large numeric scale makes narrow typed rows large, without raw cards/user
-- profiles. Totals round once. Native admission must measure this resource case.
INSERT INTO public.hand_history(id,created_at,pot_size,rake_amount,bbj_amount,winners)
SELECT ('c4053803-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,now(),1,0,0,
 ('[{"amount":0.'||repeat('0',16000)||'1}]')::jsonb
 FROM generate_series(1,200) g;
INSERT INTO case_result VALUES('byte_limit_error',cash_qualification.expect_error(
 'SELECT public.fn_cash_pot_conservation_check()','cash_pot_check_evidence_limit','54000'));
SELECT cash_qualification.assert_true(
 (SELECT (result->>'detail')::jsonb->>'limit_kind'='narrow_evidence_bytes'
 AND ((result->>'detail')::jsonb->>'observed_lower_bound')::bigint>8388608
 FROM case_result WHERE name='byte_limit_error')
 AND (SELECT count(*)=1 FROM public.ca_cash_pot_check_evidence)
 AND (SELECT count(*)=21 FROM public.ca_cash_pot_check_anomalies)
 AND (SELECT q=(SELECT count(*) FROM public.operational_alert_events)
   AND f IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.financial_alerts f)
   FROM before_byte_overflow),
 '8MiB overflow no partial identities/header/queue');
ROLLBACK TO case_byte_limit;

SAVEPOINT case_false_receipt;
CREATE FUNCTION cash_qualification.change_receipt() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.payload:=NEW.payload||'{"tampered":true}'::jsonb; RETURN NEW; END $f$;
CREATE TRIGGER qualification_corrupt_receipt BEFORE INSERT ON public.operational_alert_events
 FOR EACH ROW EXECUTE FUNCTION cash_qualification.change_receipt();
SELECT cash_qualification.expect_error('SELECT public.fn_cash_pot_conservation_check()',
 'cash_pot_check_evidence_receipt_mismatch');
SELECT cash_qualification.assert_true((SELECT count(*)=1 FROM public.ca_cash_pot_check_evidence)
 AND (SELECT count(*)=1 FROM public.operational_alert_events),'false receipt rolls back complete check');
ROLLBACK TO case_false_receipt;
SAVEPOINT case_no_receipt;
CREATE FUNCTION cash_qualification.drop_receipt() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NULL; END $f$;
CREATE TRIGGER qualification_drop_receipt BEFORE INSERT ON public.operational_alert_events
 FOR EACH ROW EXECUTE FUNCTION cash_qualification.drop_receipt();
SELECT cash_qualification.expect_error('SELECT public.fn_cash_pot_conservation_check()',
 'cash_pot_check_evidence_receipt_mismatch');
ROLLBACK TO case_no_receipt;

-- Exact-key changed payload: receipt id may be positive, but the row still
-- contains the first payload. Exercise the existing writer's real conflict path.
SAVEPOINT case_collision;
CREATE FUNCTION cash_qualification.seed_collision() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
 IF NEW.source='cash-pot-conservation-measurement' AND pg_trigger_depth()=1 THEN
   INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
    VALUES(NEW.source,NEW.event_key,NEW.alertname,NEW.status,NEW.severity,NEW.payload||'{"prior":true}');
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER qualification_collision BEFORE INSERT ON public.operational_alert_events
 FOR EACH ROW EXECUTE FUNCTION cash_qualification.seed_collision();
SELECT cash_qualification.expect_error('SELECT public.fn_cash_pot_conservation_check()',
 'cash_pot_check_evidence_receipt_mismatch');
SELECT cash_qualification.assert_true((SELECT count(*)=1 FROM public.operational_alert_events),
 'collision conflict retry cannot acknowledge another payload');
ROLLBACK TO case_collision;

-- Deliberate drift is local fixture state only. Each expected failure is
-- bracketed so an unexpected successful install cannot pass unnoticed.
SAVEPOINT case_guard_schema;
ALTER TABLE public.ca_cash_pot_check_evidence ADD COLUMN wrong_extra integer;
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.sql
\set schema_guard_error :ERROR
\set schema_guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_guard_schema;
SELECT cash_qualification.assert_true(:'schema_guard_error'::boolean
 AND :'schema_guard_state'='P0001','install refuses complete-schema drift');
SAVEPOINT case_guard_acl;
GRANT UPDATE ON public.ca_cash_pot_check_evidence TO service_role;
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
\set acl_guard_error :ERROR
\set acl_guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_guard_acl;
SELECT cash_qualification.assert_true(:'acl_guard_error'::boolean
 AND :'acl_guard_state'='P0001','rollback refuses authority drift');
SAVEPOINT case_guard_dep;
ALTER FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) SECURITY DEFINER;
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.sql
\set dependency_guard_error :ERROR
\set dependency_guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_guard_dep;
SELECT cash_qualification.assert_true(:'dependency_guard_error'::boolean
 AND :'dependency_guard_state'='P0001','install refuses dependency authority drift');

SAVEPOINT case_view_kind;
DROP VIEW public.ca_cash_pot_check_anomalies;
CREATE TABLE public.ca_cash_pot_check_anomalies(check_id uuid);
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.sql
\set view_kind_error :ERROR
\set view_kind_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_view_kind;
SELECT cash_qualification.assert_true(:'view_kind_error'::boolean AND :'view_kind_state'='P0001',
 'unexpected old table is refused without conversion');
SAVEPOINT case_view_definition;
ALTER VIEW public.ca_cash_pot_check_anomalies SET (security_invoker=false);
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
\set view_security_error :ERROR
\set view_security_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_view_definition;
SELECT cash_qualification.assert_true(:'view_security_error'::boolean AND :'view_security_state'='P0001',
 'rollback refuses changed view security');
SAVEPOINT case_view_filter;
CREATE OR REPLACE VIEW public.ca_cash_pot_check_anomalies WITH(security_invoker=true) AS
 SELECT d.* FROM public.ca_cash_pot_check_evidence h
 CROSS JOIN LATERAL jsonb_to_recordset(h.anomalies) AS d(
 check_id uuid,ordinal integer,condition_kind text,hand_id uuid,table_id uuid,hand_number integer,
 created_at timestamptz,pot numeric,rake numeric,bbj numeric,recorded_awarded numeric,winner_count integer,
 winner_state text,signed_residual numeric,absolute_residual numeric,evidence_bytes integer)
 WHERE false;
\set ON_ERROR_STOP off
\ir ../../supabase/components/cash-pot-check-evidence.sql
\set view_filter_error :ERROR
\set view_filter_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO case_view_filter;
SELECT cash_qualification.assert_true(:'view_filter_error'::boolean AND :'view_filter_state'='P0001',
 'matching columns cannot hide a view that omits all evidence');

-- Capture after the actual native CREATE normalization, not a caller-supplied
-- "passed" hash. Retaining rollback must match these exact installed bytes.
CREATE TEMP TABLE before_rollback AS SELECT
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY check_id) FROM public.ca_cash_pot_check_evidence h) h,
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY check_id,ordinal) FROM public.ca_cash_pot_check_anomalies d) d,
 (SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM public.operational_alert_events q) q,
 (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.financial_alerts f) f;
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
SELECT cash_qualification.assert_true(
 md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure))=
 '484ca087624199de5a28678a2799ff75','rollback restores exact original definition');
SELECT cash_qualification.assert_true(
 (SELECT h=(SELECT jsonb_agg(to_jsonb(x) ORDER BY check_id) FROM public.ca_cash_pot_check_evidence x)
 AND d=(SELECT jsonb_agg(to_jsonb(x) ORDER BY check_id,ordinal) FROM public.ca_cash_pot_check_anomalies x)
 AND q=(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.operational_alert_events x)
 AND f IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.financial_alerts x)
 FROM before_rollback),'rollback retains all immutable evidence, receipts and financial rows');
\ir ../../supabase/components/cash-pot-check-evidence.rollback.sql
\ir ../../supabase/components/cash-pot-check-evidence.sql
SELECT cash_qualification.assert_true(
 (SELECT candidate=pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure)
 AND guard=pg_get_functiondef('public.fn_ca_cash_pot_evidence_append_only()'::regprocedure)
 FROM qualified_bodies),'reinstall from retained schema exact postimage');
SELECT jsonb_build_object('stage','source_cases_complete_if_execution_reaches_here',
 'execution_uuid',current_setting('cash_qualification.execution_uuid'),
 'candidate_definition_md5',md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure)),
 'guard_definition_md5',md5(pg_get_functiondef('public.fn_ca_cash_pot_evidence_append_only()'::regprocedure)),
 'native_version',version(),'claimed_scope','isolated narrow schema cases only',
 'complete_bundle_qualified',false,'cleanup_observed',false);
ROLLBACK;
-- The protected owner must observe the actual backend/container stopped and
-- allocation cleaned. Reaching ROLLBACK is not that terminal cleanup receipt.
