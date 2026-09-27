-- Disposable paid REGISTERING event: preserve legitimate existing-entry seating.
-- The modeled closed chair is not dealt gameplay or historical recovery.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
CREATE TEMP TABLE horse_pre_q AS SELECT :'execution_uuid'::uuid execution,
 :'tournament_uuid'::uuid tournament, :'ordinary_user_uuid'::uuid player,
 :'horse_profile'::boolean horse_profile;
CREATE TEMP TABLE horse_pre_result(result jsonb);
\ir ../spin-history-retention/database-state.sql
CREATE FUNCTION pg_temp.pre_assert(ok boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'Horse prestart: %',message; END IF; END$$;
SELECT pg_temp.pre_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_spin_expiry_'||replace(q.execution::text,'-','')
 AND current_setting('qualification.execution_uuid',true)=q.execution::text
 AND current_setting('session_replication_role')='origin' AND inet_server_addr() IS NULL
 AND (SELECT status='REGISTERING' AND prize_pool_finalized IS FALSE
 FROM public.tournaments WHERE id=q.tournament),'actual private paid prestart event required')
FROM horse_pre_q q;
UPDATE public.profiles p SET is_horse=q.horse_profile FROM horse_pre_q q WHERE p.id=q.player;
SELECT pg_temp.pre_assert((SELECT is_horse FROM public.profiles WHERE id=q.player)
 IS NOT DISTINCT FROM q.horse_profile,'actual profile classification required') FROM horse_pre_q q;
CREATE TEMP TABLE horse_pre_before AS SELECT pg_temp.retention_database_state() state;
UPDATE public.table_seats s SET left_at=clock_timestamp() FROM horse_pre_q q,public.tables t
WHERE s.table_id=t.id AND t.tournament_id=q.tournament AND s.user_id=q.player AND s.left_at IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
GRANT SELECT ON horse_pre_q TO service_role;
GRANT INSERT ON horse_pre_result TO service_role;
DO $$BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
END$$;
SET LOCAL ROLE service_role;
INSERT INTO horse_pre_result SELECT public.fn_seat_horse_in_seat_first_game(tournament,player)
FROM horse_pre_q;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
CREATE TEMP TABLE horse_pre_after AS SELECT pg_temp.retention_database_state() state;
CREATE TEMP TABLE horse_pre_money AS SELECT bool_and(
 b.state ? name AND a.state ? name AND b.state->name=a.state->name) unchanged
FROM horse_pre_before b,horse_pre_after a,
unnest(ARRAY['public.clubs','public.club_members','public.chip_ledger','public.chip_transactions',
 'public.wallet_transactions','public.tournament_escrow','public.spin_bonus_pools',
 'public.spin_reserve_ledger','public.rake_records','public.accounting_tournament_fee_sources',
 'public.tournament_refund_entitlements','public.ca_mint_ledger']) name;
SELECT jsonb_build_object('stage','prestart_existing_entry','execution',q.execution,
 'tournament',q.tournament,'horse_profile',q.horse_profile,'response',r.result,
 'money_unchanged',m.unchanged,'status',(SELECT status FROM public.tournaments WHERE id=q.tournament),
 'live_seats',(SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
 WHERE t.tournament_id=q.tournament AND s.left_at IS NULL),
 'live_stack',(SELECT sum(s.stack) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
 WHERE t.tournament_id=q.tournament AND s.left_at IS NULL),
 'synthetic_closed_chair',true,'full_financial_qualification',false,'production_qualification',false)
FROM horse_pre_q q,horse_pre_result r,horse_pre_money m;
SELECT pg_temp.pre_assert(r.result->>'ok'='true' AND r.result->>'reused_registration'='true'
 AND r.result->>'reused_seat'='true' AND (r.result->>'stack')::numeric=1000 AND m.unchanged
 AND (SELECT count(*)=3 AND sum(s.stack)=3000 FROM public.table_seats s
 JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=q.tournament AND s.left_at IS NULL),
 'legitimate prestart reopening must preserve paid money and exactly three starting stacks')
FROM horse_pre_q q,horse_pre_result r,horse_pre_money m;
-- Explicit malformed legacy boundary, matching the retained old event's
-- REGISTERING/finalized shape. No entry-close or historic receipt is fabricated.
UPDATE public.tournaments SET prize_pool_finalized=true
WHERE id=(SELECT tournament FROM horse_pre_q);
UPDATE public.table_seats s SET left_at=clock_timestamp() FROM horse_pre_q q,public.tables t
WHERE s.table_id=t.id AND t.tournament_id=q.tournament AND s.user_id=q.player AND s.left_at IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
CREATE TEMP TABLE horse_final_before AS SELECT pg_temp.retention_database_state() state,
 pg_temp.retention_sequence_state() sequences;
TRUNCATE horse_pre_result;
SET LOCAL ROLE service_role;
INSERT INTO horse_pre_result SELECT public.fn_seat_horse_in_seat_first_game(tournament,player)
FROM horse_pre_q;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('stage','finalized_prestart_refusal','execution',q.execution,
 'tournament',q.tournament,'horse_profile',q.horse_profile,'response',r.result,
 'state_unchanged',b.state=pg_temp.retention_database_state(),
 'sequences_unchanged',b.sequences=pg_temp.retention_sequence_state(),
 'modeled_legacy_finalized_flag',true,'historical_qualification',false,
 'full_financial_qualification',false,'production_qualification',false)
FROM horse_pre_q q,horse_pre_result r,horse_final_before b;
SELECT pg_temp.pre_assert(r.result=jsonb_build_object('ok',false,'reason','registration_closed')
 AND b.state=pg_temp.retention_database_state()
 AND b.sequences=pg_temp.retention_sequence_state(),
 'finalized legacy prestart must refuse without persistent mutation')
FROM horse_pre_result r,horse_final_before b;
ROLLBACK;
