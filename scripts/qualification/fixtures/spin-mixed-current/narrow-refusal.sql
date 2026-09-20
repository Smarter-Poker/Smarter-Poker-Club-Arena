BEGIN;
SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='1s';
SELECT public.fn_ca_lock_settlement_lane_for_finish(current_setting('spin_mixed_qualification.tournament_id')::uuid);
SELECT public.fn_ca_spin_mixed_dispatch_enter_v1(
 current_setting('spin_mixed_qualification.tournament_id')::uuid,
 current_setting('spin_mixed_qualification.winner_id')::uuid,'places');
DO $no_upgrade$
DECLARE message text;
BEGIN
 BEGIN
  PERFORM public.fn_ca_spin_mixed_admit_v1(
   current_setting('spin_mixed_qualification.tournament_id')::uuid,
   current_setting('spin_mixed_qualification.winner_id')::uuid);
  RAISE EXCEPTION 'admission upgraded/accepted narrow lane' USING ERRCODE='PZ999';
 EXCEPTION WHEN SQLSTATE 'P0404' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message<>'mixed-basis admission requires initial exclusive settlement barriers'
   THEN RAISE EXCEPTION 'wrong admission refusal: %',message; END IF;
 END;
 IF EXISTS(SELECT 1 FROM public.ca_spin_mixed_basis_v1)
 OR EXISTS(SELECT 1 FROM public.ca_spin_mixed_completion_v1)
 OR EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
  AND l.mode='ExclusiveLock' AND l.objsubid=1
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND (l.classid,l.objid) IN (
   SELECT ((k>>32)&4294967295)::oid,(k&4294967295)::oid FROM unnest(ARRAY[
    hashtextextended('ca:tournament-terminal-settlement:v1',0),
    hashtextextended('ca:hand-settlement-barrier:v1',0)]) keys(k)))
 THEN RAISE EXCEPTION 'admission refusal left exclusive G/B or evidence'; END IF;
END $no_upgrade$;
SELECT jsonb_build_object('narrow_lane_admission_refused',true,'classification_race_qualified',false);
ROLLBACK;
