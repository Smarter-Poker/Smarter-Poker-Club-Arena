-- THE LEAGUE HEALTH AUDIT STATES WHO MAY CALL IT (2026-09-27)
--
-- Sibling to 20260927220532, which re-declared fn_audit_nightly_job_health.
-- The live grant is already correct - proacl reads
-- {postgres=X/postgres,service_role=X/postgres}, so anon has never been able
-- to call it - but that was settled in an older migration, and a
-- CREATE OR REPLACE that does not restate it leaves the branch asserting
-- nothing. check-definer-authorization reads the branch, not the database,
-- and it is right to: a function whose authorization lives only in history is
-- one refactor away from being re-created wide open.
--
-- This is operator and engine telemetry (remedy 1 of that check). It is
-- called only by fn_run_horse_daily_audit, itself SECURITY DEFINER and
-- therefore unaffected by these grants, and it backs ZERO RLS policies -
-- checked against pg_policy before revoking, per the check's own warning that
-- revoking a policy helper denies every SELECT on the tables whose policies
-- call it.
--
-- Idempotent and a no-op against the current live ACL; it exists so the
-- statement is in the branch where the checker and the next reader can see it.
revoke all on function public.fn_audit_nightly_job_health(date)
  from public, anon, authenticated;
grant execute on function public.fn_audit_nightly_job_health(date)
  to service_role;