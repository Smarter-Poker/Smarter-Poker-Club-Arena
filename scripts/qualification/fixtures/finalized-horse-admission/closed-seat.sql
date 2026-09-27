-- One modeled malformed chair state in a disposable genuine paid-entry estate.
-- This is not dealt gameplay, historical restoration, or financial qualification.
-- The old public endpoint must visibly reset the closed winning chair; the
-- candidate must refuse without changing any persisted row. Both roll back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SET LOCAL timezone='UTC';
CREATE TEMP TABLE horse_q_inputs AS SELECT
  :'execution_uuid'::uuid execution, :'tournament_uuid'::uuid tournament,
  :'ordinary_user_uuid'::uuid player, :'expect_refusal'::boolean expect_refusal,
 :'horse_profile'::boolean horse_profile;
CREATE TEMP TABLE horse_q_result(result jsonb);
CREATE TEMP TABLE horse_q_before(state jsonb, sequences jsonb);
CREATE FUNCTION pg_temp.horse_assert(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'Finalized horse admission: %',message; END IF; END$$;
\ir ../spin-history-retention/database-state.sql
SELECT pg_temp.horse_assert(current_user='postgres' AND session_user='postgres'
 AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 AND current_database()='qual_spin_expiry_'||replace(execution::text,'-','')
 AND current_setting('qualification.execution_uuid',true)=execution::text
 AND current_setting('session_replication_role')='origin'
 AND inet_server_addr() IS NULL,'private nonsuperuser native allocation required')
FROM horse_q_inputs;
SELECT pg_temp.horse_assert((SELECT count(*)=3 AND sum(s.stack)=3*t.starting_chips
 FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
 JOIN public.tournaments t ON t.id=b.tournament_id
 WHERE t.id=q.tournament AND s.left_at IS NULL GROUP BY t.starting_chips)
 AND (SELECT status='RUNNING' FROM public.tournaments WHERE id=q.tournament),
 'real paid draw and completed launch must precede malformed closed-chair case') FROM horse_q_inputs q;
-- Classify only this isolated synthetic profile/club for the horse-class case.
-- Actual current house-board guard decides eligibility; no guard is disabled.
SELECT pg_temp.horse_assert((SELECT public.fn_ca_house_board_allows_automation(t.club_id)
 FROM public.tournaments t WHERE t.id=q.tournament),'actual initial house board eligibility required')
 FROM horse_q_inputs q;
UPDATE public.profiles p SET is_horse=true FROM horse_q_inputs q
 WHERE p.id=q.player AND q.horse_profile;
SELECT pg_temp.horse_assert((SELECT is_horse FROM public.profiles WHERE id=q.player)
 IS NOT DISTINCT FROM q.horse_profile,'exact requested profile class required') FROM horse_q_inputs q;
GRANT SELECT ON horse_q_inputs TO service_role;
GRANT INSERT ON horse_q_result TO service_role;
DO $$BEGIN
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
END$$;
-- Running existing-chair replay must remain exactly read-only for either class.
INSERT INTO horse_q_before SELECT pg_temp.retention_database_state(),pg_temp.retention_sequence_state();
SET LOCAL ROLE service_role;
INSERT INTO horse_q_result SELECT public.fn_seat_horse_in_seat_first_game(tournament,player)
FROM horse_q_inputs;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
CREATE TEMP TABLE horse_q_replay AS SELECT r.result,
 b.state=pg_temp.retention_database_state() state_unchanged,
 b.sequences=pg_temp.retention_sequence_state() sequences_unchanged
FROM horse_q_result r,horse_q_before b;
SELECT pg_temp.horse_assert(result=jsonb_build_object('ok',true,'already_seated',true)
 AND state_unchanged AND sequences_unchanged,'live running replay must be read-only') FROM horse_q_replay;
TRUNCATE horse_q_result,horse_q_before;
-- Explicit synthetic finish input: aggregate every original starting stack in
-- one chair, then close that chair while leaving its active roster present.
-- No fake hand, draw, prize, wallet credit, funding receipt or disablement.
UPDATE public.table_seats s SET stack=CASE WHEN s.user_id=q.player
 THEN 3*t.starting_chips ELSE 0 END
FROM horse_q_inputs q,public.tables b,public.tournaments t
WHERE b.id=s.table_id AND t.id=b.tournament_id AND t.id=q.tournament AND s.left_at IS NULL;
UPDATE public.tournament_players p SET chips=CASE WHEN p.user_id=q.player
 THEN 3*t.starting_chips ELSE 0 END
FROM horse_q_inputs q,public.tournaments t
WHERE p.tournament_id=q.tournament AND t.id=q.tournament;
UPDATE public.table_seats s SET left_at=clock_timestamp()
FROM horse_q_inputs q,public.tables b
WHERE b.id=s.table_id AND b.tournament_id=q.tournament AND s.user_id=q.player;
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO horse_q_before SELECT pg_temp.retention_database_state(),pg_temp.retention_sequence_state();
SET LOCAL ROLE service_role;
INSERT INTO horse_q_result SELECT public.fn_seat_horse_in_seat_first_game(tournament,player)
FROM horse_q_inputs;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('stage','closed_winning_chair','execution',q.execution,
 'tournament',q.tournament,'candidate',q.expect_refusal,'horse_profile',q.horse_profile,'response',r.result,
 'live_replay',(SELECT to_jsonb(replay) FROM horse_q_replay replay),
 'state_unchanged',b.state=pg_temp.retention_database_state(),
 'sequences_unchanged',b.sequences=pg_temp.retention_sequence_state(),
 'synthetic_finish_input',true,'dealt_gameplay',false,'historical_qualification',false,
 'full_financial_qualification',false,'production_qualification',false)
FROM horse_q_inputs q,horse_q_result r,horse_q_before b;
SELECT pg_temp.horse_assert(CASE WHEN q.expect_refusal THEN
 r.result=jsonb_build_object('ok',false,'reason','game_already_started')
 AND b.state=pg_temp.retention_database_state()
 AND b.sequences=pg_temp.retention_sequence_state()
 ELSE (r.result->>'ok')::boolean IS TRUE
 AND (r.result->>'reused_registration')::boolean IS TRUE
 AND (r.result->>'reused_seat')::boolean IS TRUE
 AND (SELECT s.stack=t.starting_chips FROM public.table_seats s
 JOIN public.tables tb ON tb.id=s.table_id JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE t.id=q.tournament AND s.user_id=q.player AND s.left_at IS NULL)
 END,'exact old replacement or candidate row-preserving refusal required')
FROM horse_q_inputs q,horse_q_result r,horse_q_before b;
ROLLBACK;
