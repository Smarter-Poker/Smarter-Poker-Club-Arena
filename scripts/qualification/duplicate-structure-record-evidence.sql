-- SOURCE ONLY / UNRUN. Native PostgreSQL qualification, not an execution receipt.
-- Requires a protected disposable allocation, PostgreSQL 17, pinned psql -X,
-- ON_ERROR_STOP and approved qualification.execution_uuid. No network, production
-- credential, dependency acquisition or live data. Minimal public table model:
-- exact consumed column types/nullability/PKs, not the full financial schema or
-- downstream incident trigger. Real installed preimage and candidate SQL execute.
-- Original UUIDs/amounts/timestamps remain in temporary inputs. Only the modeled
-- payout created_at values are translated by ONE interval to exercise the exact
-- candidate's real now()/24h predicate without replacing its clock or source.
\set ON_ERROR_STOP on
DO $admission$
DECLARE v_id text := current_setting('qualification.execution_uuid',true);
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_duplicate_' || replace(v_id,'-','')
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
     OR session_user <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f'))
     OR to_regprocedure('public.fn_ca_duplicate_structure_payout_check(integer)') IS NOT NULL
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'Requires the protected owner''s empty disposable PostgreSQL 17 qualification allocation';
  END IF;
END;
$admission$;
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SET LOCAL timezone = 'UTC';
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',label; END IF; END $$;
CREATE TABLE public.tournament_payouts (
  id uuid PRIMARY KEY,tournament_id uuid NOT NULL,user_id uuid NOT NULL,
  position integer,amount numeric(15,2) NOT NULL,source text NOT NULL,
  created_at timestamptz NOT NULL,paid_at timestamptz NOT NULL,idempotency_key text);
CREATE UNIQUE INDEX uq_tournament_payouts_idempotency_key ON public.tournament_payouts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE public.wallet_credit_idempotency (
  key text PRIMARY KEY,user_id uuid,amount numeric,created_at timestamptz NOT NULL);
CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),severity text NOT NULL,
  source text NOT NULL,message text NOT NULL,context jsonb,resolved boolean NOT NULL DEFAULT false);
\ir fixtures/duplicate-structure-record-evidence/preimage.sql
CREATE TEMP TABLE qualification_original_payouts (LIKE public.tournament_payouts);
CREATE TEMP TABLE qualification_original_keys (LIKE public.wallet_credit_idempotency);
CREATE TEMP TABLE qualification_original_lineage (
  tournament_id uuid,user_id uuid,classification text,wallet_credit_records integer);
\ir fixtures/duplicate-structure-record-evidence/original-40430.sql
CREATE TEMP TABLE qualification_before_authority AS
  SELECT proowner,proacl,proconfig,prosecdef,prorettype,proargtypes,prosrc
  FROM pg_proc WHERE oid='public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure;
CREATE TEMP TABLE qualification_outputs (label text PRIMARY KEY,result jsonb);
SELECT pg_temp.assert_true((SELECT count(*)=60 AND count(DISTINCT id)=60 FROM qualification_original_payouts), '60 exact original payout IDs');
SELECT pg_temp.assert_true((SELECT count(*)=60 FROM qualification_original_keys), '60 original key records');
SELECT pg_temp.assert_true((SELECT count(*)=30 AND count(DISTINCT tournament_id)=24 FROM qualification_original_lineage), '30 original pairs across 24 tournaments');
SELECT pg_temp.assert_true((SELECT count(*)=7 AND bool_and((wallet_credit_records=1) IS TRUE)
  FROM qualification_original_lineage WHERE classification='corrective_place_key_was_burned_without_second_credit'), 'seven burned-key groups have one retained credit each');
INSERT INTO public.tournament_payouts
SELECT id,tournament_id,user_id,position,amount,source,
  created_at + (now()-timestamptz '2026-09-01 13:37:00.606737+00'),paid_at,idempotency_key
FROM qualification_original_payouts;
INSERT INTO public.wallet_credit_idempotency SELECT * FROM qualification_original_keys;
CREATE TEMP TABLE qualification_input_snapshot AS SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p) payouts,
  (SELECT jsonb_agg(to_jsonb(w) ORDER BY key) FROM public.wallet_credit_idempotency w) keys;
INSERT INTO qualification_outputs VALUES ('before',public.fn_ca_duplicate_structure_payout_check(24));
SELECT pg_temp.assert_true((SELECT (result->>'players_double_paid')::int=30
  AND (result->>'tournaments')::int=24 AND (result->>'excess')::numeric=688.30
  FROM qualification_outputs WHERE label='before'), 'original nominal totals reproduced by actual preimage');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and((message LIKE '%same place%paid beyond%') IS TRUE)
  FROM public.financial_alerts), 'actual old message reproduces received false measurement');
DELETE FROM public.financial_alerts;

-- Expected negative component calls use savepoints; each observed SQLSTATE is
-- captured before rollback. An unexpected success or a different failure fails.
SAVEPOINT missing_function;
DROP FUNCTION public.fn_ca_duplicate_structure_payout_check(integer);
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO missing_function;
SELECT pg_temp.assert_true(:'guard_state'='P0001','missing/retired function refused');
SAVEPOINT changed_definition;
ALTER FUNCTION public.fn_ca_duplicate_structure_payout_check(integer) SET statement_timeout='119s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO changed_definition;
SELECT pg_temp.assert_true(:'guard_state'='P0001','changed definition refused');
SAVEPOINT changed_acl;
GRANT EXECUTE ON FUNCTION public.fn_ca_duplicate_structure_payout_check(integer) TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO changed_acl;
SELECT pg_temp.assert_true(:'guard_state'='P0001','changed ACL refused');
SAVEPOINT changed_column;
ALTER TABLE public.wallet_credit_idempotency ALTER COLUMN amount TYPE text;
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO changed_column;
SELECT pg_temp.assert_true(:'guard_state'='P0001','changed key evidence type refused');
SAVEPOINT missing_key_pk;
ALTER TABLE public.wallet_credit_idempotency DROP CONSTRAINT wallet_credit_idempotency_pkey;
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO missing_key_pk;
SELECT pg_temp.assert_true(:'guard_state'='P0001','nonunique key evidence refused');
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
SELECT pg_temp.assert_true((SELECT p.proowner=b.proowner AND p.proacl=b.proacl
  AND p.proconfig=b.proconfig AND p.prosecdef=b.prosecdef
  AND p.prorettype=b.prorettype AND p.proargtypes=b.proargtypes AND p.prosrc<>b.prosrc
  FROM pg_proc p CROSS JOIN qualification_before_authority b
  WHERE p.oid='public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure), 'authority preserved and actual body replaced');
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure))
  ='67d372ba4b1071cae4ac0d9f97035b31', 'actual native canonical postimage equals rollback pin');
CREATE TEMP TABLE qualification_native_postimage AS
  SELECT pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure) AS definition;
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure)=definition
  FROM qualification_native_postimage), 'exact candidate replay is unchanged');
INSERT INTO qualification_outputs VALUES ('after',public.fn_ca_duplicate_structure_payout_check(24));
SELECT pg_temp.assert_true((SELECT result->>'payment_evidence'='not_established_by_this_detector'
  AND (result->>'players_double_paid')::int=30 AND (result->>'tournaments')::int=24
  AND (result->>'excess')::numeric=688.30 AND (result->>'nominal_record_discrepancy')::numeric=688.30
  AND (result->'classifications'->>'groups_with_same_positive_place_duplicates')::int=0
  AND (result->'classifications'->>'groups_with_cross_positive_places')::int=30
  AND (result->>'evidence_records')::int=60 AND (result->>'evidence_records_omitted')::int=0
  FROM qualification_outputs WHERE label='after'), 'all 30 cross-place cases remain actionable with nominal semantics');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements((SELECT result->'sample' FROM qualification_outputs WHERE label='before')) b
  FULL JOIN jsonb_array_elements((SELECT result->'sample' FROM qualification_outputs WHERE label='after')) a
    ON a->>'tournament_id'=b->>'tournament_id' AND a->>'user_id'=b->>'user_id'
  WHERE a IS NULL OR b IS NULL OR a->'rows' IS DISTINCT FROM b->'rows'
    OR a->'paid' IS DISTINCT FROM b->'paid' OR a->'excess' IS DISTINCT FROM b->'excess'
    OR a->'last_at' IS DISTINCT FROM b->'last_at'), 'every legacy pair/value preserved independent of tie order');
SELECT pg_temp.assert_true((SELECT count(*)=60 AND count(DISTINCT e->>'payout_id')=60
  AND bool_and((e->>'key_evidence'='registered_key_match') IS TRUE)
  FROM qualification_outputs o CROSS JOIN LATERAL jsonb_array_elements(o.result->'record_evidence') e
  WHERE o.label='after'), 'all 60 key matches including burned keys stay reservation evidence');
SELECT pg_temp.assert_true(NOT EXISTS (
  SELECT 1 FROM qualification_original_payouts p LEFT JOIN
    jsonb_array_elements((SELECT result->'record_evidence' FROM qualification_outputs WHERE label='after')) e
    ON e->>'payout_id'=p.id::text
  WHERE e IS NULL OR e->>'idempotency_key' IS DISTINCT FROM p.idempotency_key
    OR (e->>'amount')::numeric IS DISTINCT FROM p.amount OR (e->>'position')::int IS DISTINCT FROM p.position
    OR (e->>'paid_at')::timestamptz IS DISTINCT FROM p.paid_at), 'original identities, amounts, places and paid_at preserved');
SELECT pg_temp.assert_true((SELECT payouts=(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.tournament_payouts p)
  AND keys=(SELECT jsonb_agg(to_jsonb(w) ORDER BY key) FROM public.wallet_credit_idempotency w)
  FROM qualification_input_snapshot), 'detector never rewrites payout or key evidence');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and((severity='critical'
  AND source='fn_ca_duplicate_structure_payout_check'
  AND message LIKE '%nominal record discrepancy 688.30%'
  AND context->>'payment_evidence'='not_established_by_this_detector'
  AND NOT (context ? 'discrepancy') AND NOT (context ? 'amount')) IS TRUE) FROM public.financial_alerts), 'new alert remains critical with no money-loss field');
SELECT public.fn_ca_duplicate_structure_payout_check(24);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.financial_alerts), 'existing unresolved-source dedupe unchanged');

-- Independent mixed-place cases: classifications overlap and never filter.
DELETE FROM public.tournament_payouts;
DELETE FROM public.wallet_credit_idempotency;
INSERT INTO public.tournament_payouts
SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('20000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
  '30000000-0000-4000-8000-000000000001',pos,amount,source,now(),now(),NULL
FROM (VALUES (1,1,1,10,'structure'),(2,1,1,10,'structure'),
 (3,2,1,10,'structure'),(4,2,2,10,'structure'),
 (5,3,NULL,10,'structure'),(6,3,NULL,10,'structure'),
 (7,4,0,10,'structure'),(8,4,-1,10,'structure'),
 (9,5,1,10,'structure'),(10,5,1,10,'structure'),(11,5,2,10,'structure'),(12,5,NULL,10,'structure'),
 (13,6,1,10,'structure'),(14,7,1,10,'bounty'),(15,7,1,10,'bounty'),
 (16,8,1,10,'structure'),(17,8,1,0,'structure')) x(n,g,pos,amount,source);
INSERT INTO qualification_outputs VALUES ('mixed',public.fn_ca_duplicate_structure_payout_check(24));
SELECT pg_temp.assert_true((SELECT (result->>'players_double_paid')::int=5
  AND (result->>'payout_records')::int=12 AND (result->>'excess')::numeric=70
  AND (result->'classifications'->>'groups_with_same_positive_place_duplicates')::int=2
  AND (result->'classifications'->>'groups_with_cross_positive_places')::int=2
  AND (result->'classifications'->>'groups_with_unknown_or_invalid_places')::int=3
  FROM qualification_outputs WHERE label='mixed'), 'same/cross/null/invalid/mixed places and source/amount/singleton controls');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(((context->>'nominal_record_discrepancy')::numeric=688.30) IS TRUE)
  FROM public.financial_alerts), 'dedupe does not overwrite original alert when current population changes');

-- Evidence lookup is exact-key AND exact recipient AND amount, with nulls unknown.
DELETE FROM public.tournament_payouts;
CREATE TEMP TABLE qualification_key_cases(n int,key text,expected text,expected_user boolean,expected_amount boolean);
INSERT INTO qualification_key_cases VALUES
 (1,NULL,'no_payout_key',NULL,NULL),(2,'absent','key_not_registered',NULL,NULL),
 (3,'match','registered_key_match',true,true),
 (4,'wrong_user','registered_key_mismatch_or_unknown',false,true),
 (5,'wrong_amount','registered_key_mismatch_or_unknown',true,false),
 (6,'null_user','registered_key_mismatch_or_unknown',NULL,true),
 (7,'null_amount','registered_key_mismatch_or_unknown',true,NULL),
 (8,repeat('x',600),'registered_key_match',true,true);
INSERT INTO public.tournament_payouts
SELECT ('10000000-0000-4000-8000-'||lpad((c.n*2+i)::text,12,'0'))::uuid,
  ('20000000-0000-4000-8000-'||lpad(c.n::text,12,'0'))::uuid,
  '30000000-0000-4000-8000-000000000001',i+1,10,'structure',now(),now(),CASE WHEN i=0 THEN c.key END
FROM qualification_key_cases c CROSS JOIN generate_series(0,1) i;
INSERT INTO public.wallet_credit_idempotency
SELECT key,CASE WHEN n=6 THEN NULL WHEN n=4 THEN '30000000-0000-4000-8000-000000000099'::uuid
  ELSE '30000000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n=7 THEN NULL WHEN n=5 THEN 11 ELSE 10 END,now()
FROM qualification_key_cases WHERE n>=3;
INSERT INTO qualification_outputs VALUES ('keys',public.fn_ca_duplicate_structure_payout_check(24));
SELECT pg_temp.assert_true((SELECT count(*)=8 AND bool_and((
  e->>'key_evidence'=c.expected
  AND ((e->>'key_user_matches')::boolean IS NOT DISTINCT FROM c.expected_user)
  AND ((e->>'key_amount_matches')::boolean IS NOT DISTINCT FROM c.expected_amount)) IS TRUE)
  FROM qualification_key_cases c JOIN jsonb_array_elements(
    (SELECT result->'record_evidence' FROM qualification_outputs WHERE label='keys')) e
    ON e->>'payout_id'=('10000000-0000-4000-8000-'||lpad((c.n*2)::text,12,'0'))), 'all eight exact-key/recipient/amount/null outcomes');
SELECT pg_temp.assert_true((SELECT length(e->>'idempotency_key')=512
  AND (e->>'key_characters')::int=600 AND (e->>'key_truncated')::boolean
  AND e->>'full_key_md5'=md5(repeat('x',600)) AND e->>'key_evidence'='registered_key_match'
  FROM jsonb_array_elements((SELECT result->'record_evidence' FROM qualification_outputs WHERE label='keys')) e
  WHERE e->>'payout_id'='10000000-0000-4000-8000-000000000016'), 'key lookup uses full key before bounded display');

-- Global bound must not truncate counts or silently truncate legacy sample.
DELETE FROM public.tournament_payouts;
DELETE FROM public.wallet_credit_idempotency;
INSERT INTO public.tournament_payouts
SELECT ('10000000-0000-4000-8000-'||lpad((g*10+i)::text,12,'0'))::uuid,
  ('20000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
  '30000000-0000-4000-8000-000000000001',1,g,'structure',now(),now(),NULL
FROM generate_series(1,31) g CROSS JOIN generate_series(1,5) i;
INSERT INTO qualification_outputs VALUES ('bounds',public.fn_ca_duplicate_structure_payout_check(24));
SELECT pg_temp.assert_true((SELECT (result->>'players_double_paid')::int=31
  AND (result->>'payout_records')::int=155 AND (result->>'excess')::numeric=1984
  AND jsonb_array_length(result->'sample')=31 AND jsonb_array_length(result->'record_evidence')=120
  AND (result->>'evidence_groups_omitted')::int=1 AND (result->>'evidence_records_omitted')::int=35
  FROM qualification_outputs WHERE label='bounds'), '31 groups/155 records retained; details 30 by 4, omissions exact');
SELECT pg_temp.assert_true((SELECT count(*)=31
  AND sum((e->>'evidence_records')::int)=120 AND sum((e->>'evidence_records_omitted')::int)=35
  FROM jsonb_array_elements((SELECT result->'sample' FROM qualification_outputs WHERE label='bounds')) e), 'per-group evidence omission totals agree');
SELECT pg_temp.assert_true((SELECT result->'record_evidence'=public.fn_ca_duplicate_structure_payout_check(24)->'record_evidence'
  FROM qualification_outputs WHERE label='bounds'), 'equal-created-at record selection is deterministic');

DELETE FROM public.tournament_payouts;
INSERT INTO public.tournament_payouts
SELECT ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  '20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,10,'structure',
  CASE i WHEN 1 THEN now() WHEN 2 THEN now()-interval '1 second'
    WHEN 3 THEN now()-interval '1 hour' ELSE now()-interval '1 hour 0.000001 seconds' END,
  timestamptz '2026-07-01 00:00:00+00',NULL FROM generate_series(1,4) i;
SELECT pg_temp.assert_true((SELECT bool_and(((public.fn_ca_duplicate_structure_payout_check(h)->>'payout_records')::int=2) IS TRUE)
  FROM unnest(ARRAY[1,0,-1,NULL]::integer[]) h), 'exclusive insertion window and existing null/nonpositive hour floor preserved');
SELECT pg_temp.assert_true((public.fn_ca_duplicate_structure_payout_check(24)->>'payout_records')::int=4, 'paid_at is not the selected clock');
UPDATE public.tournament_payouts SET created_at=now()+interval '1 hour';
SELECT pg_temp.assert_true((public.fn_ca_duplicate_structure_payout_check(1)->>'payout_records')::int=4, 'existing lower-bound-only predicate preserved, including future timestamps');

-- ACL actual calls, not merely text/metadata matching. Expected access denial
-- is caught in a subtransaction so the outer fixture can still roll back.
DO $$ BEGIN
  BEGIN SET LOCAL ROLE anon; PERFORM public.fn_ca_duplicate_structure_payout_check(24);
    RAISE EXCEPTION 'anon unexpectedly executed detector';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  BEGIN SET LOCAL ROLE authenticated; PERFORM public.fn_ca_duplicate_structure_payout_check(24);
    RAISE EXCEPTION 'authenticated unexpectedly executed detector';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
END $$;
SET LOCAL ROLE service_role;
SELECT public.fn_ca_duplicate_structure_payout_check(24);
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.financial_alerts), 'all repeated calls preserve unresolved-source dedupe');
UPDATE public.financial_alerts SET resolved=true;
SELECT public.fn_ca_duplicate_structure_payout_check(24);
SELECT pg_temp.assert_true((SELECT count(*)=2 AND count(*) FILTER (WHERE NOT resolved)=1 FROM public.financial_alerts), 'new alert after resolved predecessor, no automatic historical mutation');
DELETE FROM public.tournament_payouts;
SELECT pg_temp.assert_true((public.fn_ca_duplicate_structure_payout_check(24)->>'players_double_paid')::int=0, 'empty population is clean');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND count(*) FILTER (WHERE NOT resolved)=1 FROM public.financial_alerts), 'clean window neither files nor resolves alerts');
-- Rollback is an independently selected, exact-postimage operation. Refuse
-- authority/schema drift, restore literal captured preimage, and reapply exact
-- candidate without invoking the legacy function during rollback verification.
SAVEPOINT rollback_drift;
ALTER FUNCTION public.fn_ca_duplicate_structure_payout_check(integer) SET statement_timeout='119s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.rollback.sql
\set rollback_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO rollback_drift;
SELECT pg_temp.assert_true(:'rollback_state'='P0001','rollback refuses changed definition');
SAVEPOINT rollback_schema_drift;
ALTER TABLE public.wallet_credit_idempotency DROP CONSTRAINT wallet_credit_idempotency_pkey;
\set ON_ERROR_STOP off
\ir ../../supabase/components/duplicate-structure-record-evidence.rollback.sql
\set rollback_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO rollback_schema_drift;
SELECT pg_temp.assert_true(:'rollback_state'='P0001','rollback refuses changed evidence schema');
\ir ../../supabase/components/duplicate-structure-record-evidence.rollback.sql
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure))
  ='c2ceec953ff4cb6b31741fe20b75b635', 'rollback restores literal installed preimage');
\ir ../../supabase/components/duplicate-structure-record-evidence.rollback.sql
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure))
  ='c2ceec953ff4cb6b31741fe20b75b635', 'rollback replay preserves preimage');
\ir ../../supabase/components/duplicate-structure-record-evidence.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef('public.fn_ca_duplicate_structure_payout_check(integer)'::regprocedure)=definition
  FROM qualification_native_postimage), 'candidate reapplies after exact rollback');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND count(*) FILTER (WHERE NOT resolved)=1 FROM public.financial_alerts), 'source install/rollback never invokes detector or changes alerts');
SELECT md5(definition) AS native_postimage_md5,definition AS native_postimage_definition
  FROM qualification_native_postimage;
ROLLBACK;
DO $$ BEGIN
  IF to_regclass('public.tournament_payouts') IS NOT NULL
     OR to_regclass('public.wallet_credit_idempotency') IS NOT NULL
     OR to_regclass('public.financial_alerts') IS NOT NULL
     OR to_regprocedure('public.fn_ca_duplicate_structure_payout_check(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'qualification objects survived rollback';
  END IF;
END $$;
SELECT to_regclass('public.tournament_payouts') IS NULL
  AND to_regprocedure('public.fn_ca_duplicate_structure_payout_check(integer)') IS NULL AS rolled_back;
-- Executor must assert rolled_back=true, then independently observe stopped
-- container/empty allocation and durable terminal. This line is not that proof.
