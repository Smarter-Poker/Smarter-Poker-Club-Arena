-- One active minute cron called player_leave_table outside engine ownership.
-- It can observe a pre-settlement stack or retarget a newly occupied seat.
-- The existing engine already implements timed, busted and eliminated-seat
-- lifecycle handling. Retire this competing SQL writer; do not add a watcher.
-- Read-only preflight: job 152, sp_evict_sitting_out_cash_players, one-minute
-- SELECT public.fn_evict_sitting_out_cash_players(); no other SQL callers.
-- No wallet, journal, seat or historical incident data is modified here.
SET lock_timeout = '2s';
DO $guard$
DECLARE v_definition text;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO v_definition
 FROM pg_proc p WHERE p.oid='public.fn_evict_sitting_out_cash_players()'::regprocedure;
 IF md5(v_definition) NOT IN (
   'edade8a266655ff341bc97bbb4cf8f0b','6545e433f41651de49e89a1dd9ca39a1'
 ) THEN
  RAISE EXCEPTION 'SQL evictor definition changed; review before retirement';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
   AND p.proname <> 'fn_evict_sitting_out_cash_players'
   AND p.prosrc LIKE '%fn_evict_sitting_out_cash_players%') THEN
  RAISE EXCEPTION 'SQL evictor has another function caller; review before retirement';
 END IF;
 IF EXISTS (SELECT 1 FROM cron.job WHERE command ILIKE '%fn_evict_sitting_out_cash_players%'
  AND btrim(command) <> 'SELECT public.fn_evict_sitting_out_cash_players();') THEN
  RAISE EXCEPTION 'Unexpected SQL evictor job command; review before retirement';
 END IF;
END;
$guard$;
DO $retire_job$
DECLARE v_job record;
BEGIN
 FOR v_job IN SELECT jobid FROM cron.job
  WHERE btrim(command)='SELECT public.fn_evict_sitting_out_cash_players();'
 LOOP
  IF NOT cron.unschedule(v_job.jobid) THEN
   RAISE EXCEPTION 'Could not retire SQL eviction job %',v_job.jobid;
  END IF;
 END LOOP;
END;
$retire_job$;
CREATE OR REPLACE FUNCTION public.fn_evict_sitting_out_cash_players()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp
AS $retired$
BEGIN
 RAISE EXCEPTION 'SQL_EVICTOR_RETIRED_ENGINE_OWNS_DEPARTURE' USING ERRCODE='42501';
END;
$retired$;
REVOKE ALL ON FUNCTION public.fn_evict_sitting_out_cash_players()
 FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_evict_sitting_out_cash_players() IS
 'Retired: the engine owns seat departure at its hand boundary. No scheduled SQL cashout.';
