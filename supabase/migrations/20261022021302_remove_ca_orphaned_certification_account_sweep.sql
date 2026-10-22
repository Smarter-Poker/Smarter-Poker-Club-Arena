-- Withdraws 20261022014819: a scheduled sweep that cleans up after a failed certification run
-- is a band-aid under CLAUDE.md 10.12. The root cause is fixed in the certification workflow instead.
SET LOCAL lock_timeout = '5s';
SELECT cron.unschedule('ca-orphaned-certification-account-sweep');
DROP FUNCTION IF EXISTS public.fn_ca_sweep_orphaned_certification_accounts();