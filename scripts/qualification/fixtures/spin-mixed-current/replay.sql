\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='1s';
SET LOCAL timezone='Pacific/Honolulu';
DO $isolation$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 THEN RAISE EXCEPTION 'independent observer requires exact private nonsuper backend'; END IF;
END $isolation$;
CREATE TEMP TABLE replay_backend_identity AS SELECT pg_backend_pid() AS pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid();
GRANT SELECT ON replay_backend_identity TO service_role;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
DO $$ BEGIN IF current_user<>'service_role' OR auth.role()<>'service_role' OR auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'wrong replay service boundary'; END IF; END $$;
SELECT jsonb_build_object('pid',pg_backend_pid(),'backend_start',(SELECT backend_start FROM replay_backend_identity WHERE pid=pg_backend_pid()),'timezone',current_setting('TimeZone'),'user',current_user,'session_user',session_user,'receipt',public.fn_complete_tournament_terminal(current_setting('spin_mixed_qualification.tournament_id')::uuid,current_setting('spin_mixed_qualification.winner_id')::uuid,'places'));
SELECT jsonb_build_object('stage','replay_timezone_restored','pid',pg_backend_pid(),'backend_start',(SELECT backend_start FROM replay_backend_identity WHERE pid=pg_backend_pid()),'timezone',current_setting('TimeZone'));
COMMIT;
