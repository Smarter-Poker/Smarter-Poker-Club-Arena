-- SOURCE ONLY / UNRUN. Native SQL qualification; not an execution receipt.
-- Admission syntax is not approval authentication: the protected owner supplies
-- the approved execution UUID, isolated provider and terminal/cleanup receipts.
-- Exact captured preimage/candidate run against a minimal consumed-column model.
-- Production financial triggers, wallet providers and routing are NOT modeled.
\set ON_ERROR_STOP on
DO $admission$
DECLARE v_id text := current_setting('qualification.execution_uuid',true);
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_spin_' || replace(v_id,'-','')
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
     OR session_user <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'Requires protected empty disposable PostgreSQL 17 qualification allocation';
  END IF;
END;
$admission$;

BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',label; END IF; END $$;
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,name text NOT NULL,club_id uuid,prize_pool numeric(18,2),
  buy_in_amount numeric(15,2) NOT NULL,started_at timestamptz,created_at timestamptz,
  ended_at timestamptz,variant text,status text NOT NULL,spin_multiplier numeric,
  is_premium_spin boolean);
CREATE TABLE public.spin_reserve_ledger (
  id uuid PRIMARY KEY,tournament_id uuid,kind text NOT NULL,multiplier numeric,
  created_at timestamptz NOT NULL,original_evidence jsonb);
CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),severity text NOT NULL,
  source text NOT NULL,message text NOT NULL,context jsonb,resolved boolean NOT NULL DEFAULT false);
CREATE TABLE public.ca_guard_defs (proname text PRIMARY KEY);

\ir fixtures/spin-repair-evidence/preimage.sql
CREATE TEMP TABLE qualification_original_cases(inbox_id integer PRIMARY KEY,evidence jsonb NOT NULL);
\ir fixtures/spin-repair-evidence/original-40497-40499.sql
CREATE TEMP TABLE qualification_outputs(label text PRIMARY KEY,result jsonb);
CREATE TEMP TABLE qualification_before_authority AS
SELECT proowner,proacl,proconfig,prosecdef,proisstrict,provolatile,proparallel,proargtypes,prorettype
FROM pg_proc WHERE oid='public.fn_spin_repair_missing_multiplier(integer)'::regprocedure;
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure))
  ='833c06b59dfdd8fd29b74cce0c6be6a2','captured canonical preimage');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND sum((evidence->'tournament'->>'prize_pool')::numeric)=18
  AND array_agg(inbox_id ORDER BY inbox_id)=ARRAY[40497,40498,40499] FROM qualification_original_cases),
  'three literal received originals, pools3/6/9');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and((
  evidence->'original'->>'event_key'=evidence#>>'{original,payload,original_event,id}'
  AND evidence#>>'{original,payload,original_event,context,tournament_id}'=evidence->'tournament'->>'id'
  AND evidence#>>'{original,payload,original_event,severity}'='warning'
  AND (evidence#>>'{original,payload,original_event,created_at}')::timestamptz
      =timestamptz '2026-08-22 18:24:04.240366+00'
  AND jsonb_array_length(evidence->'wallet_rows')=4
  AND jsonb_array_length(evidence->'reserve_rows')=2
  AND jsonb_array_length(evidence->'payout_rows')=1
  ) IS TRUE) FROM qualification_original_cases),
  'exact original identities and retained row cardinalities');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND sum((w->>'amount')::numeric)=18
  AND bool_and((w->>'type'='credit' AND w->>'balance_after' IS NOT NULL
    AND w->>'related_entity_id'=c.evidence->'tournament'->>'id'
    AND (w->>'amount')::numeric=(c.evidence->'tournament'->>'prize_pool')::numeric) IS TRUE)
  FROM qualification_original_cases c CROSS JOIN LATERAL jsonb_array_elements(c.evidence->'wallet_rows') w
  WHERE w->>'category'='prize'),
  'three retained prize-wallet records are evidence inputs, not new payments');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and((p->>'recorded_by'='backfill_2026_08_31'
  AND p->>'tournament_id'=c.evidence->'tournament'->>'id'
  AND (p->>'created_at')::timestamptz>(c.evidence->'tournament'->>'ended_at')::timestamptz
  AND (p->>'amount')::numeric=(c.evidence->'tournament'->>'prize_pool')::numeric) IS TRUE)
  FROM qualification_original_cases c CROSS JOIN LATERAL jsonb_array_elements(c.evidence->'payout_rows') p),
  'later structure records remain distinct from original wallet credits');
CREATE TEMP TABLE qualification_original_snapshot AS SELECT * FROM qualification_original_cases;
TRUNCATE public.tournaments,public.spin_reserve_ledger,public.financial_alerts;
INSERT INTO public.tournaments
SELECT (t->>'id')::uuid,t->>'name',(t->>'club_id')::uuid,(t->>'prize_pool')::numeric,
  (t->>'buy_in_amount')::numeric,(t->>'started_at')::timestamptz+d,
  (t->>'created_at')::timestamptz+d,(t->>'ended_at')::timestamptz+d,
  t->>'variant',t->>'status',NULL,false
FROM qualification_original_cases c CROSS JOIN LATERAL
  (SELECT c.evidence->'tournament' t,now()-timestamptz '2026-08-24 00:00:00+00' d) x;

CREATE TEMP TABLE qualification_nonprojection_before AS
SELECT id,to_jsonb(t)-ARRAY['spin_multiplier','is_premium_spin'] baseline FROM public.tournaments t;
INSERT INTO qualification_outputs VALUES ('ratio_before',public.fn_spin_repair_missing_multiplier(10080));
CREATE TEMP TABLE qualification_before_alerts AS SELECT * FROM public.financial_alerts;
SELECT pg_temp.assert_true((SELECT result->>'repaired'='3' AND result->>'unreconstructable'='0'
  FROM qualification_outputs WHERE label='ratio_before'),'actual preimage repairs allthree modeled missing projections');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and((message LIKE '%restored from the reserve ledger%') IS TRUE)
  FROM public.financial_alerts),'preimage reproduces false reserve wording with no reserve rows');
TRUNCATE public.tournaments,public.spin_reserve_ledger,public.financial_alerts;
INSERT INTO public.tournaments
SELECT (t->>'id')::uuid,t->>'name',(t->>'club_id')::uuid,(t->>'prize_pool')::numeric,
  (t->>'buy_in_amount')::numeric,(t->>'started_at')::timestamptz+d,
  (t->>'created_at')::timestamptz+d,(t->>'ended_at')::timestamptz+d,
  t->>'variant',t->>'status',NULL,false
FROM qualification_original_cases c CROSS JOIN LATERAL
  (SELECT c.evidence->'tournament' t,now()-timestamptz '2026-08-24 00:00:00+00' d) x;


SAVEPOINT missing_target;
DROP FUNCTION public.fn_spin_repair_missing_multiplier(integer);
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO missing_target;
SELECT pg_temp.assert_true(:'guard_state'='P0001','missing_target refused atomically');

SAVEPOINT function_drift;
ALTER FUNCTION public.fn_spin_repair_missing_multiplier(integer) SET statement_timeout='119s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO function_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','function_drift refused atomically');

SAVEPOINT acl_drift;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO acl_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','acl_drift refused atomically');

SAVEPOINT column_drift;
ALTER TABLE public.spin_reserve_ledger ALTER COLUMN created_at TYPE text;
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO column_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','column_drift refused atomically');

SAVEPOINT identity_drift;
ALTER TABLE public.spin_reserve_ledger DROP CONSTRAINT spin_reserve_ledger_pkey;
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO identity_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','identity_drift refused atomically');

SAVEPOINT bridge_drift;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO anon;
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO bridge_drift;
SELECT pg_temp.assert_true(:'guard_state'='P0001','bridge_drift refused atomically');

SAVEPOINT original_bridge_install;
\ir fixtures/spin-repair-evidence/original-bridge.sql
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO original_bridge_install;
SELECT pg_temp.assert_true(:'guard_state'='P0001','original_bridge_install rejects pre-composition dependency');
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure))
  ='00a43ae03ab12cec9505e2bfed71d937','final composed bridge retained after refusal');

SAVEPOINT watched_target;
INSERT INTO public.ca_guard_defs VALUES ('fn_spin_repair_missing_multiplier');
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO watched_target;
SELECT pg_temp.assert_true(:'guard_state'='P0001','watched_target refused atomically');

\ir ../../supabase/components/spin-repair-evidence.sql
CREATE TEMP TABLE qualification_candidate_definition AS
SELECT pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure) definition;
\ir ../../supabase/components/spin-repair-evidence.sql
SELECT pg_temp.assert_true((SELECT pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure)=definition
  FROM qualification_candidate_definition),'exact install replay preserves native postimage');
INSERT INTO qualification_outputs VALUES ('ratio_after',public.fn_spin_repair_missing_multiplier(10080));
SELECT pg_temp.assert_true((SELECT a.result=b.result FROM qualification_outputs a,qualification_outputs b
  WHERE a.label='ratio_before' AND b.label='ratio_after'),'all ratio repair return values and counters preserved');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and((severity='info'
  AND source='fn_spin_repair_missing_multiplier'
  AND message LIKE '%recorded prize-pool/buy-in ratio%'
  AND context->>'reconstructed_from'='prize_pool / buy_in_amount'
  AND context->>'reserve_booking_timing'='not_observed'
  AND context->'reserve_booking_id'='null'::jsonb
  AND context->'reserve_booking_created_at'='null'::jsonb
  AND context->>'reserve_booking_used'='false'
  AND context->>'rng_evidence'='not_established_by_this_repair'
  AND context->>'payment_evidence'='not_established_by_this_repair'
  AND (context->>'paid_over_drawn')::numeric=0
  AND (context->>'pool_minus_selected_multiplier_amount')::numeric=0) IS TRUE) FROM public.financial_alerts),
  'allthree literal cases have honest ratio/unknown evidence');
SELECT pg_temp.assert_true(NOT EXISTS(
  SELECT 1 FROM qualification_before_alerts b FULL JOIN public.financial_alerts a
    ON a.context->>'tournament_id'=b.context->>'tournament_id'
  WHERE a.id IS NULL OR b.id IS NULL OR a.severity IS DISTINCT FROM b.severity
    OR a.source IS DISTINCT FROM b.source OR a.resolved IS DISTINCT FROM b.resolved
    OR a.context-ARRAY['evidence_version','rng_evidence','payment_evidence','amount_basis',
       'pool_minus_selected_multiplier_amount','reserve_booking_id','reserve_booking_created_at',
       'reserve_booking_used','reserve_booking_timing','ended_at'] IS DISTINCT FROM b.context),
  'every legacy numeric/context field preserved');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.tournaments t
  FULL JOIN qualification_nonprojection_before b USING(id)
  WHERE t.id IS NULL OR b.id IS NULL OR to_jsonb(t)-ARRAY['spin_multiplier','is_premium_spin'] IS DISTINCT FROM b.baseline),
  'original pool, buy-in, timestamps and all nonprojection columns unchanged');
-- Both info/warning branches stop at the captured bridge's first return.
-- The critical branch below is compared byte-for-byte to the actual preimage;
-- full production trigger/provider delivery is a separate qualification.
TRUNCATE public.tournaments,public.spin_reserve_ledger,public.financial_alerts;
INSERT INTO public.tournaments
SELECT (t->>'id')::uuid,t->>'name',(t->>'club_id')::uuid,(t->>'prize_pool')::numeric,
  (t->>'buy_in_amount')::numeric,(t->>'started_at')::timestamptz+d,
  (t->>'created_at')::timestamptz+d,(t->>'ended_at')::timestamptz+d,
  t->>'variant',t->>'status',NULL,false
FROM qualification_original_cases c CROSS JOIN LATERAL
  (SELECT c.evidence->'tournament' t,now()-timestamptz '2026-08-24 00:00:00+00' d) x;

INSERT INTO public.spin_reserve_ledger
SELECT (e->>'id')::uuid,(e->>'tournament_id')::uuid,e->>'kind',(e->>'multiplier')::numeric,
  (e->>'created_at')::timestamptz+(now()-timestamptz '2026-08-24 00:00:00+00'),e
FROM qualification_original_cases c CROSS JOIN LATERAL jsonb_array_elements(c.evidence->'reserve_rows')e;
CREATE TEMP TABLE qualification_reserve_snapshot AS SELECT * FROM public.spin_reserve_ledger;
INSERT INTO qualification_outputs VALUES ('late_booking',public.fn_spin_repair_missing_multiplier(10080));
SELECT pg_temp.assert_true((SELECT result=(SELECT result FROM qualification_outputs WHERE label='ratio_before')
  FROM qualification_outputs WHERE label='late_booking'),'late bookings preserve exact repair counters');
SELECT pg_temp.assert_true((SELECT count(*)=3 AND bool_and((a.context->>'reconstructed_from'='spin_reserve_ledger.jackpot_draw'
  AND a.context->>'reserve_booking_used'='true'
  AND a.context->>'reserve_booking_timing'='after_recorded_end'
  AND a.context->>'rng_evidence'='not_established_by_this_repair'
  AND a.message LIKE '%recorded reserve booking%') IS TRUE)
  FROM public.financial_alerts a),'Aug23 bookings do not become original RNG proof');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.financial_alerts a
  LEFT JOIN public.spin_reserve_ledger l ON l.id=(a.context->>'reserve_booking_id')::uuid
  WHERE l.id IS NULL OR l.kind<>'jackpot_draw'
    OR l.tournament_id::text IS DISTINCT FROM a.context->>'tournament_id'
    OR l.created_at IS DISTINCT FROM (a.context->>'reserve_booking_created_at')::timestamptz),
  'allthree reserve IDs/timestamps bind exact literal draw-booking rows');
SELECT pg_temp.assert_true(NOT EXISTS(
  (SELECT * FROM public.spin_reserve_ledger EXCEPT SELECT * FROM qualification_reserve_snapshot)
  UNION ALL (SELECT * FROM qualification_reserve_snapshot EXCEPT SELECT * FROM public.spin_reserve_ledger)),
  'all six literal reserve rows and their amounts/evidence remain unchanged');

\ir ../../supabase/components/spin-repair-evidence.rollback.sql
TRUNCATE public.tournaments,public.spin_reserve_ledger,public.financial_alerts;
INSERT INTO public.tournaments
SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'modeled case '||n,
 'fade0000-0000-0000-0000-000000000001',pool,buyin,
 CASE WHEN n=8 THEN NULL ELSE now()-make_interval(hours=>age_hours) END,
 now()-make_interval(hours=>age_hours),now()-interval '30 minutes',variant,'COMPLETED',existing,false
FROM (VALUES
 (1,3,1,1,'spin',NULL::numeric),(2,3,1,1,'spin',NULL),(3,7,1,1,'spin',NULL),
 (4,7,1,1,'spin',NULL),(5,100,1,1,'spin',NULL),(6,3,1,1,'spin',3),
 (7,3,1,1,'sng',NULL),(8,3,1,1,'spin',NULL),(9,3,1,200,'spin',NULL),
 (10,3,1,200,'spin',NULL)) c(n,pool,buyin,age_hours,variant,existing);
INSERT INTO public.spin_reserve_ledger
SELECT ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'jackpot_draw',mult,
 now()-make_interval(hours=>age_hours)-interval'1 minute',NULL
FROM (VALUES(1,2,1),(2,7,1),(3,7,1),(10,2,200)) x(n,mult,age_hours);
CREATE TEMP TABLE qualification_mixed_inputs AS SELECT * FROM public.tournaments;
CREATE TEMP TABLE qualification_mixed_reserves AS SELECT * FROM public.spin_reserve_ledger;
INSERT INTO qualification_outputs VALUES ('mixed_before',public.fn_spin_repair_missing_multiplier(10080));
CREATE TEMP TABLE qualification_mixed_before_alerts AS SELECT * FROM public.financial_alerts;
TRUNCATE public.tournaments,public.financial_alerts;
INSERT INTO public.tournaments SELECT * FROM qualification_mixed_inputs;
\ir ../../supabase/components/spin-repair-evidence.sql
INSERT INTO qualification_outputs VALUES ('mixed_after',public.fn_spin_repair_missing_multiplier(10080));
SELECT pg_temp.assert_true((SELECT a.result=b.result AND a.result->>'repaired'='5'
  AND a.result->>'unreconstructable'='2' AND a.result->>'paid_over_drawn_count'='2'
  AND a.result->>'repaired_outside_window'='1'
  FROM qualification_outputs a,qualification_outputs b WHERE a.label='mixed_after' AND b.label='mixed_before'),
  'tier, fallback, age, start-null and severity-related arithmetic equivalent');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND bool_and((a.message=b.message AND a.context=b.context
  AND a.severity=b.severity AND a.source=b.source AND a.resolved=b.resolved) IS TRUE)
  FROM public.financial_alerts a JOIN qualification_mixed_before_alerts b
    ON a.context->>'tournament_id'=b.context->>'tournament_id' WHERE a.severity='critical'),
  'critical message/context/source/dedupe inputs unchanged');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND bool_and((severity='warning'
  AND (context->>'paid_over_drawn')::numeric=1
  AND (context->>'pool_minus_selected_multiplier_amount')::numeric=1
  AND context->>'payment_evidence'='not_established_by_this_repair'
  AND context->>'reserve_booking_timing'='at_or_before_recorded_start'
  AND message LIKE '%payment not verified; no clawback%') IS TRUE)
  FROM public.financial_alerts WHERE severity='warning'),
  'valid pre-start booking and pool delta remain distinct from verified payment/RNG');
SELECT pg_temp.assert_true((SELECT (context->>'reconstructed_multiplier')::numeric=3
  AND (context->>'ledger_witness_multiplier')::numeric=7
  AND context->>'reserve_booking_used'='false'
  FROM public.financial_alerts WHERE context->>'tournament_id'='10000000-0000-4000-8000-000000000002'),
  'invalid-tier booking does not suppress valid ratio fallback');
SELECT pg_temp.assert_true((SELECT is_premium_spin IS TRUE AND spin_multiplier=100
  FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000005'),'premium tier unchanged');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.tournaments t FULL JOIN qualification_mixed_inputs b USING(id)
  WHERE t.id IS NULL OR b.id IS NULL OR to_jsonb(t)-ARRAY['spin_multiplier','is_premium_spin']
    IS DISTINCT FROM to_jsonb(b)-ARRAY['spin_multiplier','is_premium_spin']),'no mixed-case money or nonprojection update');
SELECT pg_temp.assert_true(NOT EXISTS(
 (SELECT * FROM public.spin_reserve_ledger EXCEPT SELECT * FROM qualification_mixed_reserves)
 UNION ALL (SELECT * FROM qualification_mixed_reserves EXCEPT SELECT * FROM public.spin_reserve_ledger)),
 'repair never changes reserve evidence');
SELECT public.fn_spin_repair_missing_multiplier(10080);
SELECT pg_temp.assert_true((SELECT count(*)=7 FROM public.financial_alerts),'unreconstructable original-tournament dedupe unchanged');

-- Row-count zero is qualified here by an explicit veto, not presented as a
-- concurrent race. The separate isolation spec owns the real two-session race.
TRUNCATE public.tournaments,public.spin_reserve_ledger,public.financial_alerts;
INSERT INTO public.tournaments VALUES
 ('30000000-0000-4000-8000-000000000001','veto case',NULL,3,1,now(),now(),NULL,'spin','RUNNING',NULL,false);
CREATE FUNCTION public.qualification_veto_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RETURN NULL; END $$;
CREATE TRIGGER qualification_veto BEFORE UPDATE ON public.tournaments
 FOR EACH ROW EXECUTE FUNCTION public.qualification_veto_projection();
INSERT INTO qualification_outputs VALUES ('veto',public.fn_spin_repair_missing_multiplier(60));
SELECT pg_temp.assert_true((SELECT result->>'repaired'='0' AND result->>'lost_the_race'='1'
  FROM qualification_outputs WHERE label='veto'),'ROW_COUNT zero emits no false repair');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.financial_alerts),'veto emits no alert');
DROP TRIGGER qualification_veto ON public.tournaments;
DROP FUNCTION public.qualification_veto_projection();

SAVEPOINT original_bridge_rollback;
\ir fixtures/spin-repair-evidence/original-bridge.sql
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.rollback.sql
\set guard_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO original_bridge_rollback;
SELECT pg_temp.assert_true(:'guard_state'='P0001','original_bridge_rollback rejects pre-composition dependency');
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure))
  ='00a43ae03ab12cec9505e2bfed71d937','final composed bridge retained after refusal');

SAVEPOINT rollback_drift;
ALTER FUNCTION public.fn_spin_repair_missing_multiplier(integer) SET statement_timeout='119s';
\set ON_ERROR_STOP off
\ir ../../supabase/components/spin-repair-evidence.rollback.sql
\set rollback_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO rollback_drift;
SELECT pg_temp.assert_true(:'rollback_state'='P0001','rollback refuses unknown candidate');
\ir ../../supabase/components/spin-repair-evidence.rollback.sql
\ir ../../supabase/components/spin-repair-evidence.rollback.sql
SELECT pg_temp.assert_true(md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure))
  ='833c06b59dfdd8fd29b74cce0c6be6a2','exact rollback and rollback replay restore captured definition');
SELECT pg_temp.assert_true((SELECT p.proowner=b.proowner AND p.proacl=b.proacl
  AND p.proconfig=b.proconfig AND p.prosecdef=b.prosecdef AND p.proisstrict=b.proisstrict
  AND p.provolatile=b.provolatile AND p.proparallel=b.proparallel
  AND p.proargtypes=b.proargtypes AND p.prorettype=b.prorettype
  FROM pg_proc p CROSS JOIN qualification_before_authority b
  WHERE p.oid='public.fn_spin_repair_missing_multiplier(integer)'::regprocedure),'target authority preserved');
SELECT pg_temp.assert_true(NOT EXISTS(
 (SELECT * FROM qualification_original_cases EXCEPT SELECT * FROM qualification_original_snapshot)
 UNION ALL (SELECT * FROM qualification_original_snapshot EXCEPT SELECT * FROM qualification_original_cases)),
 'original financial payloads, wallet/prize evidence and timestamps never rewritten');
SELECT 'spin-repair-evidence-native-postimage' stage,md5(definition) definition_md5,definition
FROM qualification_candidate_definition;
ROLLBACK;
-- This proves only transaction rollback if execution reaches it. The protected
-- executor must independently prove closed connections, stopped/empty allocation,
-- final source hashes and no production access; this script cannot claim that.
