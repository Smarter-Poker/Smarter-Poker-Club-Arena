\set ON_ERROR_STOP on
-- Final declared input, after the exact catalog supplement and real triggers.
-- The nonsatellite trigger runs normally. This is not a generated launch claim.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $guard$
BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'postgres'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
    OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
    OR current_setting('session_replication_role')<>'origin'
    OR (SELECT count(*) FROM public.tournaments)<>1
    OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000001' AND name='Synthetic mixed consumer' AND status='RUNNING')
    OR EXISTS(SELECT 1 FROM public.tournament_entry_close_receipts)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_entry_close_receipts'::regclass
       AND tgname='aaa_require_satellite_economics_at_entry_close' AND tgenabled='O') THEN
   RAISE EXCEPTION 'synthetic entry-close input requires admitted isolated starting estate' USING ERRCODE='55000';
 END IF;
END $guard$;
INSERT INTO public.tournament_entry_close_receipts(tournament_id,close_mode,entry_closed_at,final_prize_pool,
 payout_structure_snapshot,reprice_completed_at,created_at,updated_at)
VALUES('10000000-0000-4000-8000-000000000001','immediate','2026-09-01T00:00:00Z',20,
 '[{"place":1,"percentage":100}]','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
COMMIT;
