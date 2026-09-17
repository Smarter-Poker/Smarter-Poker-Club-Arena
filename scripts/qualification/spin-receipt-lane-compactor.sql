-- SOURCE ONLY / UNRUN. Run before and after lane component in the same genuine
-- isolated provider state. The provider supplies an enabled compaction policy;
-- this file does not enable production maintenance or create a business row.
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
 IF current_user<>'postgres'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid')::uuid::text,'-','')
    OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
    OR (SELECT count(*) FROM public.hand_history_compaction_policy)<>1
    OR NOT EXISTS(SELECT 1 FROM public.hand_history_compaction_policy WHERE enabled IS TRUE) THEN
   RAISE EXCEPTION 'compactor control requires the separately admitted enabled fixture policy';
 END IF;
END $guard$;
DO $accepted$
DECLARE r jsonb;
BEGIN
 r:=public.sp_compact_hand_history(1,1,1);
 IF (jsonb_typeof(r)='object' AND
     (r->'compacted'='true'::jsonb OR (r->'compacted'='false'::jsonb
       AND r->>'reason' IN ('table_is_published','already_compact')))) IS NOT TRUE THEN
   RAISE EXCEPTION 'compactor no longer reaches its existing accepted path: %',r;
 END IF;
 RAISE NOTICE 'compactor accepted-path observation: %',r;
END $accepted$;
CREATE FUNCTION pg_temp.mixed_unrelated_update() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RETURN NEW; END $f$;
CREATE TRIGGER mixed_qualification_unrelated_update BEFORE UPDATE OF reported ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION pg_temp.mixed_unrelated_update();
DO $refusal$
DECLARE r jsonb;
BEGIN
 r:=public.sp_compact_hand_history(1,1,1);
 IF r IS DISTINCT FROM '{"compacted":false,"reason":"update_trigger_present"}'::jsonb THEN
   RAISE EXCEPTION 'unrelated applicable UPDATE trigger was not refused: %',r;
 END IF;
END $refusal$;
ROLLBACK;
