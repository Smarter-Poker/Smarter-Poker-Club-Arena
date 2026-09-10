-- Actual accepted-hand lock ownership, isolated and rolled back.
BEGIN;
SELECT fixture_accept();
DO $$ DECLARE b bigint:=hashtextextended('ca:hand-settlement-barrier:v1',0);
 old_root bigint:=hashtextextended('ca:tournament-terminal-settlement:v1',0);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
   AND mode='ShareLock' AND granted AND objsubid=1
   AND classid::bigint=((b>>32)&4294967295) AND objid::bigint=(b&4294967295)) THEN
   RAISE EXCEPTION 'accepted Diamond hand omitted shared hand-settlement barrier'; END IF;
 IF EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
   AND objsubid=1 AND classid::bigint=((old_root>>32)&4294967295)
   AND objid::bigint=(old_root&4294967295)) THEN
   RAISE EXCEPTION 'accepted Diamond hand reacquired obsolete global lifecycle lock'; END IF;
 RAISE NOTICE 'PASS: actual accepted Diamond hand retains shared barrier without obsolete global lifecycle lock';
END $$;
ROLLBACK;
BEGIN;
UPDATE public.tables SET tournament_id='80000000-0000-0000-0000-000000000001'
 WHERE id='30000000-0000-0000-0000-000000000001';
SELECT public.fn_ca_share_settlement_lane_for_table('30000000-0000-0000-0000-000000000001');
DO $$ DECLARE t bigint:=hashtextextended(
 'ca:tournament-terminal-settlement:v1:80000000-0000-0000-0000-000000000001',0);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
   AND mode='ShareLock' AND granted AND objsubid=1
   AND classid::bigint=((t>>32)&4294967295) AND objid::bigint=(t&4294967295)) THEN
   RAISE EXCEPTION 'production helper omitted this tournament shared lane'; END IF;
 IF has_function_privilege('authenticated','public.fn_ca_share_settlement_lane_for_table(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.fn_ca_share_settlement_lane_for_table(uuid)','EXECUTE')
   OR NOT has_function_privilege('service_role','public.fn_ca_share_settlement_lane_for_table(uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'production helper execution ACL changed'; END IF;
 RAISE NOTICE 'PASS: production helper retains tournament-scoped shared lane and private execution ACL';
END $$;
ROLLBACK;
