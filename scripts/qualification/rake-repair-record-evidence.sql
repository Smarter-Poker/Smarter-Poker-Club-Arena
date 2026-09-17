-- SOURCE ONLY / UNRUN. Actual repair caller over a bounded private spy model.
-- Actual atomic banking is not executed. Native admission additionally requires
-- no production credentials/network, an external deadline and cleanup receipt.
\set ON_ERROR_STOP on
DO $admission$
DECLARE v_id text:=current_setting('qualification.execution_uuid',true);
BEGIN
 IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR current_database()<>'qual_repair_'||replace(v_id,'-','')
 OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN('127.0.0.1'::inet,'::1'::inet))
 OR session_user<>'postgres' OR current_user<>'postgres'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p','v','m','f'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('fn_rake_repair_unbanked','atomic_distribute_rake','fn_ca_guard_watchlist'))
 OR (SELECT count(*) FROM pg_roles WHERE rolname IN('anon','authenticated','service_role'))<>3 THEN
  RAISE EXCEPTION 'Requires protected empty PostgreSQL17 repair-report allocation';
 END IF;
END;
$admission$;
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',label; END IF; END $$;
\ir fixtures/rake-repair-record-evidence/setup.sql
CREATE TEMP TABLE qualification_preserved_original(payload jsonb);
INSERT INTO qualification_preserved_original VALUES($original${"id":"a3760f99-e341-4328-9407-322a5fa8dd30","source":"fn_rake_repair_unbanked","context":{"chips":85.48,"repaired":62},"message":"Recovered 62 unbanked rake hand(s) totalling 85.48 chips (engine did not survive to bank them). Attribution not invented: contributions were lost with the engine.","resolved":false,"severity":"warning","created_at":"2026-09-01T17:52:02.7044+00:00","resolution":null,"resolved_at":null,"resolved_by":null}$original$::jsonb);
CREATE TEMP TABLE qualification_preimage AS SELECT oid,pg_get_functiondef(oid) definition,proowner,proacl,proconfig,prosecdef FROM pg_proc
WHERE oid='public.fn_rake_repair_unbanked(integer,integer)'::regprocedure;
SELECT pg_temp.assert_true((SELECT md5(definition)='3d2ae7b1afa7510d91057d9ceca9c9b6' FROM qualification_preimage),'exact live caller preimage');
SELECT pg_temp.assert_true((SELECT jsonb_array_length(payload)=62 FROM qualification_received_40522),'all62 received hand identities');
CREATE FUNCTION pg_temp.exercise(v_case text) RETURNS jsonb LANGUAGE plpgsql AS $exercise$
DECLARE v_out jsonb;v_returns jsonb;v_attempts bigint;
BEGIN
 TRUNCATE public.hand_history,public.tables,public.rake_records,public.rake_distribution_legs,public.pending_fee_distributions,public.financial_alerts,
 pg_temp.qualification_modes,pg_temp.qualification_calls,pg_temp.qualification_bank_moves;
 ALTER SEQUENCE pg_temp.qualification_attempts RESTART WITH 1;
 INSERT INTO public.financial_alerts SELECT (jsonb_populate_record(NULL::public.financial_alerts,payload)).* FROM pg_temp.qualification_preserved_original;
 IF v_case='received40522' THEN
  INSERT INTO public.tables(id,club_id) SELECT DISTINCT x.table_id,x.club_id FROM pg_temp.qualification_received_40522 q,jsonb_to_recordset(q.payload)x(table_id uuid,club_id uuid);
  -- Pot100 and now()-1h are SYNTHETIC; original hand rows are absent now.
  INSERT INTO public.hand_history(id,table_id,rake_amount,bbj_amount,pot_size,created_at,hand_number)
  SELECT x.hand_id,x.table_id,x.rake_amount,x.bbj_amount,100,now()-interval '1 hour',x.hand_number FROM pg_temp.qualification_received_40522 q,
  jsonb_to_recordset(q.payload)x(hand_id uuid,table_id uuid,rake_amount numeric,bbj_amount numeric,hand_number bigint);
  INSERT INTO public.rake_distribution_legs(leg_key,leg,amount,created_at)
  SELECT x.hand_id,c.leg,c.amount,c.created_at FROM pg_temp.qualification_received_40522 q,jsonb_to_recordset(q.payload)x(hand_id uuid,claims jsonb),
  jsonb_to_recordset(x.claims)c(leg text,amount numeric,created_at timestamptz);
 ELSE
  INSERT INTO public.tables(id,club_id) VALUES('00000000-0000-4000-8000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3');
  INSERT INTO public.hand_history(id,table_id,rake_amount,bbj_amount,pot_size,created_at,hand_number)
  VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001',
  CASE v_case WHEN 'fresh50' THEN 50 WHEN 'fresh50_01' THEN 50.01 ELSE 0.11 END,0,100,now()-interval '1 hour',1);
  IF v_case IN('already_processed','throw') THEN
   INSERT INTO pg_temp.qualification_modes VALUES('00000000-0000-4000-8000-000000000010',v_case);
  ELSIF v_case='excluded' THEN
   INSERT INTO public.rake_records(hand_id,table_id,metadata) VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','{"hand_number":1}');
   INSERT INTO public.hand_history(id,table_id,rake_amount,bbj_amount,pot_size,created_at,hand_number)
   VALUES('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001',0.11,0,1,now()-interval '1 hour',2);
   INSERT INTO public.pending_fee_distributions(hand_id,hand_number,kind) VALUES('00000000-0000-4000-8000-000000000020',2,'rake');
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY hand_id),'[]'::jsonb) INTO v_returns FROM public.fn_rake_repair_unbanked()x;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO v_attempts FROM pg_temp.qualification_attempts;
 PERFORM pg_temp.assert_true((SELECT to_jsonb(f)=o.payload FROM public.financial_alerts f,pg_temp.qualification_preserved_original o WHERE f.id=(o.payload->>'id')::uuid),'original financial UUID/payload preserved');
 SELECT jsonb_build_object('returns',v_returns,'attempts',v_attempts,
 'calls',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY hand_id),'[]'::jsonb) FROM pg_temp.qualification_calls c),
 'bank_moves',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY hand_id),'[]'::jsonb) FROM pg_temp.qualification_bank_moves c),
 'record_hand_ids',(SELECT coalesce(jsonb_agg(hand_id ORDER BY hand_id),'[]'::jsonb) FROM public.rake_records),
 'claim_rows',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY leg_key,leg),'[]'::jsonb) FROM public.rake_distribution_legs c),
 'new_alerts',(SELECT coalesce(jsonb_agg(to_jsonb(f)-'id'),'[]'::jsonb) FROM public.financial_alerts f WHERE f.id<>(SELECT(payload->>'id')::uuid FROM pg_temp.qualification_preserved_original)),
 'new_ids_valid',(SELECT count(*)=count(DISTINCT f.id) AND bool_and((f.id IS NOT NULL) IS TRUE) FROM public.financial_alerts f))
 INTO v_out;
 RETURN v_out;
END;
$exercise$;
CREATE TEMP TABLE qualification_results(phase text,case_name text,result jsonb,PRIMARY KEY(phase,case_name));
SELECT pg_temp.install_atomic_spy();
INSERT INTO qualification_results SELECT 'before',c,pg_temp.exercise(c) FROM unnest(ARRAY['received40522','fresh50','fresh50_01','already_processed','throw','excluded'])c;
SELECT pg_temp.restore_actual_atomic();
SAVEPOINT missing_target;
DROP FUNCTION public.fn_rake_repair_unbanked(integer,integer);
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO missing_target;
SELECT pg_temp.assert_true(:'guard_state'='P0001','missing target refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'missing target rollback restores preimage');
SAVEPOINT target_acl;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer,integer) TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO target_acl;
SELECT pg_temp.assert_true(:'guard_state'='P0001','target_acl refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'target_acl retains preimage');
SAVEPOINT target_owner;
ALTER FUNCTION public.fn_rake_repair_unbanked(integer,integer) OWNER TO service_role;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO target_owner;
SELECT pg_temp.assert_true(:'guard_state'='P0001','target_owner refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'target_owner retains preimage');
SAVEPOINT target_body;
ALTER FUNCTION public.fn_rake_repair_unbanked(integer,integer) SET statement_timeout='539s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO target_body;
SELECT pg_temp.assert_true(:'guard_state'='P0001','target_body refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'target_body retains preimage');
SAVEPOINT atomic_drift;
ALTER FUNCTION public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text) SET statement_timeout='29s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO atomic_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','atomic_drift refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'atomic_drift retains preimage');
SAVEPOINT watchlist_drift;
ALTER FUNCTION public.fn_ca_guard_watchlist() SET statement_timeout='1s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO watchlist_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','watchlist_drift refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'watchlist_drift retains preimage');
SAVEPOINT baseline_mode;
INSERT INTO public.ca_guard_defs VALUES('fn_rake_repair_unbanked');
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO baseline_mode;
SELECT pg_temp.assert_true(:'guard_state'='P0001','baseline_mode refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'baseline_mode retains preimage');
SAVEPOINT event_uuid;
ALTER TABLE public.financial_alerts ALTER COLUMN id DROP DEFAULT;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO event_uuid;
SELECT pg_temp.assert_true(:'guard_state'='P0001','event_uuid refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'event_uuid retains preimage');
SAVEPOINT event_identity;
ALTER TABLE public.financial_alerts DROP CONSTRAINT financial_alerts_pkey;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO event_identity;
SELECT pg_temp.assert_true(:'guard_state'='P0001','event_identity refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'event_identity retains preimage');
SAVEPOINT bank_identity;
ALTER TABLE public.rake_distribution_legs DROP CONSTRAINT rake_distribution_legs_pkey;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO bank_identity;
SELECT pg_temp.assert_true(:'guard_state'='P0001','bank_identity refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'bank_identity retains preimage');
SAVEPOINT record_identity;
DROP INDEX public.uq_rake_records_hand_id;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO record_identity;
SELECT pg_temp.assert_true(:'guard_state'='P0001','record_identity refused');
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'record_identity retains preimage');
\ir ../../supabase/components/rake-repair-record-evidence.sql
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_rake_repair_unbanked(integer,integer)'::regprocedure))='825c2564f326b54eb16e7f90303aa453','native canonical postimage');
SELECT pg_temp.assert_true((SELECT p.proowner=b.proowner AND p.proacl=b.proacl AND p.proconfig=b.proconfig AND p.prosecdef=b.prosecdef FROM qualification_preimage b JOIN pg_proc p ON p.oid=b.oid),'exact caller authority');
CREATE TEMP TABLE qualification_postimage AS SELECT pg_get_functiondef(oid) definition FROM qualification_preimage;
\ir ../../supabase/components/rake-repair-record-evidence.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef('public.fn_rake_repair_unbanked(integer,integer)'::regprocedure)=definition FROM qualification_postimage),'exact install replay');
SELECT pg_temp.install_atomic_spy();
INSERT INTO qualification_results SELECT 'after',c,pg_temp.exercise(c) FROM unnest(ARRAY['received40522','fresh50','fresh50_01','already_processed','throw','excluded'])c;
SELECT pg_temp.restore_actual_atomic();
SELECT pg_temp.assert_true((SELECT count(*)=6 FROM qualification_results WHERE phase='after'),'six cases present');
SELECT pg_temp.assert_true((SELECT count(*)=6 AND bool_and((result->>'new_ids_valid'='true') IS TRUE)
 FROM qualification_results WHERE phase='after'),'all original/new event UUIDs remain valid and distinct');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM qualification_results b JOIN qualification_results a USING(case_name)
 WHERE b.phase='before' AND a.phase='after' AND (b.result-'new_alerts') IS DISTINCT FROM(a.result-'new_alerts')),'exact arguments/returns/counters/claims/model bank outcomes unchanged');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM qualification_results b JOIN qualification_results a USING(case_name)
 WHERE b.phase='before' AND a.phase='after' AND
 (SELECT coalesce(jsonb_agg(x-'message'),'[]'::jsonb) FROM jsonb_array_elements(b.result->'new_alerts')x) IS DISTINCT FROM
 (SELECT coalesce(jsonb_agg(x-'message'),'[]'::jsonb) FROM jsonb_array_elements(a.result->'new_alerts')x)),
 'source/legacy context/status/severity/time unchanged; generated UUIDs separate');
SELECT pg_temp.assert_true((SELECT jsonb_array_length(result->'returns')=62 AND (result->>'attempts')::int=62
 AND jsonb_array_length(result->'bank_moves')=0 AND jsonb_array_length(result->'record_hand_ids')=62 AND jsonb_array_length(result->'claim_rows')=124
 AND result->'new_alerts'->0->'context'='{"repaired":62,"chips":85.48}'::jsonb
 AND result->'new_alerts'->0->>'severity'='warning' AND result->'new_alerts'->0->>'resolved'='false'
 FROM qualification_results WHERE phase='after' AND case_name='received40522'),'62 repaired records are not modeled as new banking85.48');
SELECT pg_temp.assert_true((SELECT count(*)=62 AND bool_and((c->>'applied'='true' AND c->>'bank_claim_new'='false') IS TRUE)
 FROM qualification_results r CROSS JOIN LATERAL jsonb_array_elements(r.result->'calls')c WHERE r.phase='after' AND r.case_name='received40522'),
 'applied true remains independent of new bank claim');
SELECT pg_temp.assert_true((SELECT result->'calls'->0->>'applied'='false' AND jsonb_array_length(result->'returns')=1
 AND result->'new_alerts'->0->'context'='{"repaired":1,"chips":0.11}'::jsonb FROM qualification_results WHERE phase='after' AND case_name='already_processed'),
 'counter remains completed calls, not first-record receipts');
SELECT pg_temp.assert_true((SELECT result->'new_alerts'->0->>'severity'='info' AND result->'new_alerts'->0->>'resolved'='true'
 AND (result->'new_alerts'->0->>'resolved_at') IS NOT NULL FROM qualification_results WHERE phase='after' AND case_name='fresh50'),'50 info/resolved');
SELECT pg_temp.assert_true((SELECT result->'new_alerts'->0->>'severity'='warning' AND result->'new_alerts'->0->>'resolved'='false'
 AND result->'new_alerts'->0->'resolved_at'='null'::jsonb FROM qualification_results WHERE phase='after' AND case_name='fresh50_01'),'50.01 warning/open');
SELECT pg_temp.assert_true((SELECT result->'returns'='[]'::jsonb AND result->'new_alerts'='[]'::jsonb AND result->'record_hand_ids'='[]'::jsonb
 AND (result->>'attempts')::int=1 FROM qualification_results WHERE phase='after' AND case_name='throw'),'failure stays uncompleted/retryable');
SELECT pg_temp.assert_true((SELECT result->'returns'='[]'::jsonb AND result->'new_alerts'='[]'::jsonb AND (result->>'attempts')::int=0
 FROM qualification_results WHERE phase='after' AND case_name='excluded'),'existing record/pending fee exclusions');
SELECT pg_temp.assert_true((SELECT count(*)=4 AND bool_and((x->>'message' LIKE 'Completed %missing-rake-record recovery call(s)%not a measure of newly credited funds.%original interruption cause is unverified.') IS TRUE)
 FROM qualification_results r CROSS JOIN LATERAL jsonb_array_elements(r.result->'new_alerts')x WHERE r.phase='after'),'four accurate future messages');
SELECT pg_temp.assert_true((SELECT count(*)=4 AND bool_and((x->>'message' LIKE 'Recovered %engine did not survive%') IS TRUE)
 FROM qualification_results r CROSS JOIN LATERAL jsonb_array_elements(r.result->'new_alerts')x WHERE r.phase='before'),'actual old claim reproduced');
-- Clear model candidates before API-role calls: actual atomic must never execute.
TRUNCATE public.hand_history;
SAVEPOINT denied_anon;
SET LOCAL ROLE anon;
\set ON_ERROR_STOP off
SELECT * FROM public.fn_rake_repair_unbanked();
\set role_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO denied_anon;
SELECT pg_temp.assert_true(:'role_state'='42501','anon cannot execute');
SAVEPOINT denied_authenticated;
SET LOCAL ROLE authenticated;
\set ON_ERROR_STOP off
SELECT * FROM public.fn_rake_repair_unbanked();
\set role_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO denied_authenticated;
SELECT pg_temp.assert_true(:'role_state'='42501','authenticated cannot execute');
SET LOCAL ROLE service_role;
SELECT count(*) AS service_count FROM public.fn_rake_repair_unbanked() \gset
RESET ROLE;
SELECT pg_temp.assert_true(:'service_count'='0','service role executes empty caller');
SAVEPOINT refused_rollback;
GRANT EXECUTE ON FUNCTION public.fn_rake_repair_unbanked(integer,integer) TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/rake-repair-record-evidence-rollback.sql
\set rollback_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO refused_rollback;
SELECT pg_temp.assert_true(:'rollback_state'='P0001','rollback refuses authority drift');
\ir ../../supabase/components/rake-repair-record-evidence-rollback.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'exact preimage restored');
\ir ../../supabase/components/rake-repair-record-evidence-rollback.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef(oid)=definition FROM qualification_preimage),'rollback replay');
\ir ../../supabase/components/rake-repair-record-evidence.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef('public.fn_rake_repair_unbanked(integer,integer)'::regprocedure)=definition FROM qualification_postimage),'exact reinstall');
ROLLBACK;
DO $cleanup$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p','v','m','f'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('fn_rake_repair_unbanked','atomic_distribute_rake','fn_ca_guard_watchlist')) THEN
  RAISE EXCEPTION 'Private repair-report qualification cleanup incomplete';
 END IF;
END;
$cleanup$;
SELECT true AS clean_private_schema;
