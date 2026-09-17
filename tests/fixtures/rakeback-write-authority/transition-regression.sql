-- Same acceptance session, AFTER complete candidate COMMIT. No table/function
-- replacement, permission augmentation or simulated old reply is allowed.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='3s';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
DO $transition$
DECLARE e record;before_rows jsonb;after_rows jsonb;legacy_payload jsonb;message text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR to_regclass('pg_temp.rakeback_precursor_evidence') IS NULL THEN
  RAISE EXCEPTION 'transition requires retained actual preactivation session';END IF;
 IF (SELECT count(*) FROM rakeback_precursor_evidence)<>1 THEN
  RAISE EXCEPTION 'precursor evidence cardinality changed';END IF;
 SELECT * INTO STRICT e FROM rakeback_precursor_evidence;
 IF e.reply IS DISTINCT FROM '{"ok":1,"failed":0,"first_error":null}'::jsonb
  OR e.before_rows IS DISTINCT FROM e.after_rows
  OR e.payload IS DISTINCT FROM jsonb_build_array(jsonb_build_object('source_type','cash_rake_record','source_id',e.source_id)) THEN
  RAISE EXCEPTION 'actual predecessor reply or no-write evidence missing';END IF;
 -- A delayed old engine could have interpreted this actual count as success
 -- and submitted a separate caller-derived statistics payload. After commit,
 -- the role is denied entry and the owner body also refuses any such payload.
 legacy_payload:=jsonb_build_array(jsonb_build_object('rake_record_id',e.source_id,
  'user_id','d0160000-0000-0000-0000-000000000001','club_id','d0160000-0000-0000-0000-000000000002',
  'hands',1,'rake',99));
 before_rows:=pg_temp.rakeback_authority_rows();
 EXECUTE 'SET LOCAL ROLE service_role';
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'transition service role missing';END IF;
 BEGIN
  PERFORM public.fn_apply_rakeback_player_stats_batch(legacy_payload);
  RAISE EXCEPTION 'old statistics RPC entered after activation commit';
 EXCEPTION WHEN insufficient_privilege THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF position('fn_apply_rakeback_player_stats_batch' in message)=0 THEN RAISE;END IF;
 END;
 EXECUTE 'RESET ROLE';
 SET CONSTRAINTS ALL IMMEDIATE;
 after_rows:=pg_temp.rakeback_authority_rows();
 IF after_rows IS DISTINCT FROM before_rows THEN RAISE EXCEPTION 'delayed service stats call changed application rows';END IF;
 BEGIN
  PERFORM public.fn_apply_rakeback_player_stats_batch(legacy_payload);
  RAISE EXCEPTION 'owner statistics RPC entered after activation commit';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'rakeback_player_stats_batch_retired' THEN RAISE;END IF;
 END;
 SET CONSTRAINTS ALL IMMEDIATE;
 after_rows:=pg_temp.rakeback_authority_rows();
 IF after_rows IS DISTINCT FROM before_rows THEN RAISE EXCEPTION 'retired owner stats call changed application rows';END IF;
 RAISE NOTICE 'transition proof: actual preactivation count reply retained across candidate COMMIT cannot enter the retired statistics writer; full application rows unchanged';
END $transition$;
ROLLBACK;

