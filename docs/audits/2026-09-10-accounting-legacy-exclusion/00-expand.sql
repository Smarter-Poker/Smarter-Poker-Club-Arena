-- UNAPPLIED ONLINE EXPANSION. Historical rows remain NULL.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
ALTER TABLE public.agent_commissions ADD COLUMN commission_capture_version integer
 CHECK(commission_capture_version IS NULL OR commission_capture_version=1);
COMMIT;
