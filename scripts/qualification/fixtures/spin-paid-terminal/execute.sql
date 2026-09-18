-- Disposable current-path compatibility only. The paid entries, launch, draw,
-- fee and prize receipts below must be written by their actual authorities.
-- Two declared synthetic busts supply finish input; no hand history is invented.
\set ON_ERROR_STOP on
SET statement_timeout='15s'; SET lock_timeout='2s';
SET idle_in_transaction_session_timeout='20s'; SET timezone='UTC';
SET search_path=public,pg_temp;
\ir ../spin-receipt-lane/boundary.sql
\ir ../spin-history-retention/database-state.sql
CREATE TEMP TABLE paid_q AS SELECT :'execution_uuid'::uuid execution,
 :'tournament_uuid'::uuid tournament, :'ordinary_user_uuid'::uuid winner,
 extensions.uuid_generate_v5(:'execution_uuid'::uuid,'paid-launch') launch,
 extensions.uuid_generate_v5(:'execution_uuid'::uuid,'paid-lease') generation,
 clock_timestamp() started_at, :'rule_manifest'::jsonb rules;
CREATE TEMP TABLE paid_calls(stage text PRIMARY KEY,result jsonb NOT NULL);
CREATE TEMP TABLE paid_snapshots(stage text PRIMARY KEY,estate jsonb NOT NULL);
GRANT SELECT ON paid_q TO service_role;
GRANT INSERT,SELECT ON paid_calls TO service_role;
CREATE FUNCTION pg_temp.paid_assert(ok boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'paid terminal qualification: %',message; END IF; END$$;
CREATE FUNCTION pg_temp.paid_observe(label text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('stage',label,'execution',q.execution,'tournament',q.tournament,
 'winner',q.winner,'launch',q.launch,'generation',q.generation,'rules',q.rules,
 'estate',pg_temp.retention_database_state(),
 'calls',(SELECT coalesce(jsonb_object_agg(stage,result),'{}'::jsonb) FROM paid_calls),
 'synthetic_finish_input',true,'historical_qualification',false,
 'full_financial_qualification',false,'production_qualification',false) FROM paid_q q
$$;
SELECT pg_temp.paid_assert((SELECT count(*)=3 AND bool_and(status='playing' AND chips=1000)
 FROM public.tournament_players) AND (SELECT count(*)=1 AND bool_and(status='REGISTERING')
 FROM public.tournaments) AND NOT EXISTS(SELECT 1 FROM public.spin_draw_receipts)
 AND NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts),
 'real committed entries must precede launch');
SELECT pg_temp.paid_observe('paid_before_launch');
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'lease',to_jsonb(l) FROM paid_q q CROSS JOIN LATERAL
 public.claim_tournament_lease_v2(q.tournament,'qualification:'||q.execution,'current-source',q.generation,30) l;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT (result->>'granted')::boolean FROM paid_calls WHERE stage='lease'),'real lease granted');
COMMIT;
INSERT INTO paid_snapshots VALUES('lease',pg_temp.retention_database_state());
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'wrong_generation',public.fn_begin_tournament_launch_atomic(
 tournament,launch,started_at,launch,'spin-v1') FROM paid_q;
INSERT INTO paid_calls SELECT 'wrong_format',public.fn_begin_tournament_launch_atomic(
 tournament,launch,started_at,generation,'sng-v1') FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'reason'='launch_lease_lost' AND result->>'ok'='false' FROM paid_calls WHERE stage='wrong_generation')
 AND (SELECT result->>'reason'='launch_format_mismatch' AND result->>'ok'='false' FROM paid_calls WHERE stage='wrong_format'),
 'actual incorrect lease and format refusals');
COMMIT;
SELECT pg_temp.paid_assert(pg_temp.retention_database_state()=(SELECT estate FROM paid_snapshots WHERE stage='lease'),
 'refused requests leave every business row unchanged');
SELECT pg_temp.paid_observe('paid_launch_refusals');
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'begin',public.fn_begin_tournament_launch_atomic(tournament,launch,started_at,generation,'spin-v1') FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' AND result->>'completed'='false' FROM paid_calls WHERE stage='begin'),'real launch begins');
COMMIT;
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'draw',public.fn_spin_draw_and_settle_atomic(tournament,launch,generation,rules) FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' FROM paid_calls WHERE stage='draw'),'real funded draw accepted');
COMMIT;
SELECT pg_temp.paid_observe('paid_draw_committed');
INSERT INTO paid_snapshots VALUES('draw',pg_temp.retention_database_state());
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'draw_replay',public.fn_spin_draw_and_settle_atomic(tournament,launch,generation,rules) FROM paid_q;
RESET ROLE;
COMMIT;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' FROM paid_calls WHERE stage='draw_replay')
 AND pg_temp.retention_database_state()=(SELECT estate FROM paid_snapshots WHERE stage='draw'),'confirmed draw replay changes no row');
SELECT pg_temp.paid_observe('paid_draw_replay');
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'complete_launch',public.fn_complete_tournament_launch_atomic(tournament,launch,generation,'spin-v1') FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' AND result->>'status'='RUNNING' FROM paid_calls WHERE stage='complete_launch'),'actual roster and funded draw permit RUNNING');
COMMIT;
SELECT pg_temp.paid_observe('paid_running');
-- Explicit model input, not an actual hand or recovered historical result.
-- All ordinary triggers remain enabled. Only tournament play chips move here.
BEGIN;
UPDATE public.tournament_players p SET status='eliminated',chips=0,
 elimination_sequence=CASE WHEN p.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid THEN 1 ELSE 2 END,
 position=CASE WHEN p.user_id='47965354-0e56-43ef-931c-ddaab82af765'::uuid THEN 3 ELSE 2 END,
 eliminated_at=clock_timestamp()
 FROM paid_q q WHERE p.tournament_id=q.tournament AND p.user_id<>q.winner;
UPDATE public.tournament_players p SET chips=3000 FROM paid_q q
 WHERE p.tournament_id=q.tournament AND p.user_id=q.winner;
UPDATE public.table_seats s SET stack=CASE WHEN s.user_id=q.winner THEN 3000 ELSE 0 END
 FROM paid_q q,public.tables t WHERE t.tournament_id=q.tournament AND s.table_id=t.id;
COMMIT;
SELECT pg_temp.paid_observe('paid_synthetic_finish');
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'finish_claim',public.fn_claim_tournament_finish(tournament,winner,'isolated-synthetic-finish-input') FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' AND result->>'status'='COMPLETING' FROM paid_calls WHERE stage='finish_claim'),'actual finish authority claims sole survivor');
COMMIT;
SELECT pg_temp.paid_observe('paid_finish_claimed');
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
SELECT pg_temp.paid_assert(current_user='service_role' AND auth.uid() IS NULL AND auth.role()='service_role','service caller without user identity');
INSERT INTO paid_calls SELECT 'terminal',public.fn_complete_tournament_terminal(tournament,winner,'places') FROM paid_q;
RESET ROLE;
SELECT pg_temp.paid_assert((SELECT result->>'ok'='true' AND result->>'fully_settled'='true' AND result->>'status'='COMPLETED' FROM paid_calls WHERE stage='terminal'),'actual terminal writer commits complete receipt');
COMMIT;
SELECT pg_temp.paid_observe('paid_terminal_committed');
INSERT INTO paid_snapshots VALUES('terminal',pg_temp.retention_database_state());
BEGIN;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
INSERT INTO paid_calls SELECT 'terminal_replay',public.fn_complete_tournament_terminal(tournament,winner,'places') FROM paid_q;
RESET ROLE;
COMMIT;
SELECT pg_temp.paid_assert((SELECT a.result=b.result FROM paid_calls a,paid_calls b WHERE a.stage='terminal' AND b.stage='terminal_replay')
 AND pg_temp.retention_database_state()=(SELECT estate FROM paid_snapshots WHERE stage='terminal'),
 'confirmed terminal replay retains exact response and complete estate');
SELECT pg_temp.paid_observe('paid_terminal_replay');
