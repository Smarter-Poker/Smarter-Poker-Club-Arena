\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='1s';
DO $isolation$
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
 OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
 OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_basis_v1)
 OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_completion_v1)
 OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_dispatch_v1)
 THEN RAISE EXCEPTION 'wrong private fresh mixed control boundary'; END IF;
END $isolation$;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
DO $wrapper_refusals$
DECLARE which text; message text; observed boolean; before_locks jsonb; after_locks jsonb;
BEGIN
 FOREACH which IN ARRAY ARRAY['shared_G','prior_parent_row'] LOOP
  observed:=false;
  BEGIN
   IF which='shared_G' THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0));
   ELSE
    PERFORM 1 FROM public.tournaments
     WHERE id=current_setting('spin_mixed_qualification.tournament_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing synthetic parent'; END IF;
   END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('database',database,'classid',classid,'objid',objid,'objsubid',objsubid,'mode',mode,'granted',granted)
     ORDER BY database,classid,objid,objsubid,mode),'[]'::jsonb)
    INTO before_locks FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';
   EXECUTE 'SET LOCAL ROLE service_role';
   IF current_user<>'service_role' OR auth.role() IS DISTINCT FROM 'service_role' OR auth.uid() IS NOT NULL
    THEN RAISE EXCEPTION 'wrong service role before wrapper'; END IF;
   BEGIN
    PERFORM public.fn_complete_tournament_terminal(
      current_setting('spin_mixed_qualification.tournament_id')::uuid,
      current_setting('spin_mixed_qualification.winner_id')::uuid,'places');
    RAISE EXCEPTION 'wrapper accepted unsafe first acquisition' USING ERRCODE='PZ999';
   EXCEPTION WHEN SQLSTATE 'P0404' THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    IF message<>'mixed-basis initial admission requires a fresh first-acquisition transaction'
     THEN RAISE EXCEPTION 'wrong wrapper refusal: %',message; END IF;
    observed:=true;
   END;
   EXECUTE 'RESET ROLE';
   SELECT coalesce(jsonb_agg(jsonb_build_object('database',database,'classid',classid,'objid',objid,'objsubid',objsubid,'mode',mode,'granted',granted)
     ORDER BY database,classid,objid,objsubid,mode),'[]'::jsonb)
    INTO after_locks FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory';
   IF after_locks IS DISTINCT FROM before_locks
    OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_dispatch_v1)
    OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_basis_v1)
    OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_completion_v1)
    THEN RAISE EXCEPTION 'refusal left a new hold or mixed evidence'; END IF;
   RAISE EXCEPTION 'rollback injected prior hold' USING ERRCODE='PZ901';
  EXCEPTION WHEN SQLSTATE 'PZ901' THEN NULL;
  END;
  IF NOT observed OR current_user<>'postgres'
   OR EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory')
   THEN RAISE EXCEPTION 'wrapper refusal/hold rollback was not proven'; END IF;
 END LOOP;
END $wrapper_refusals$;
SELECT jsonb_build_object('wrapper_first_acquisition_refusals',2);
ROLLBACK;
