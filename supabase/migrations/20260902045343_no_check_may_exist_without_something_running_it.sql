-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902045343; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- The meta-guard. A check is "covered" if a cron job names it, the
-- conservation sweep calls it, the money-check registry tracks it, or a human
-- exempted it WITH A REASON. Anything else is a function somebody wrote to
-- protect the platform that nothing has ever called.
--
-- Coverage is derived by reading the sweep's own body, so adding a check to
-- the sweep is enough - there is no second list to remember to update, which
-- is how the first twenty got lost.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_orphaned_checks()
RETURNS TABLE(proname text, args text, why text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH sweep AS (
    SELECT COALESCE(
      (SELECT pg_get_functiondef(p.oid)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep'
        LIMIT 1), '') AS body
  ),
  candidates AS (
    SELECT p.proname::text AS pn,
           pg_get_function_identity_arguments(p.oid) AS ar
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND p.proname ~ '(conservation|_check$|_audit$|_watch$|integrity)'
       AND p.proname NOT LIKE '%selftest%'
  )
  SELECT c.pn, c.ar,
         'exists but nothing runs it: no cron entry, not called by fn_ca_conservation_sweep, and no exemption reason'
    FROM candidates c, sweep s
   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.command LIKE '%' || c.pn || '%')
     AND position(c.pn IN s.body) = 0
     AND NOT EXISTS (SELECT 1 FROM public.ca_check_sweep_exemptions e WHERE e.proname = c.pn)
   ORDER BY 1;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_ca_orphaned_checks_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_n int; v_rows jsonb;
BEGIN
  SELECT count(*), jsonb_agg(jsonb_build_object('fn', o.proname, 'args', o.args))
    INTO v_n, v_rows
    FROM public.fn_ca_orphaned_checks() o;

  IF COALESCE(v_n,0) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_orphaned_checks_watch', 'unknown', 'warning',
      'orphaned-checks:' || CURRENT_DATE::text,
      0, NULL, NULL, 'ledger', 'pg_proc',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_n || ' integrity check function(s) exist that nothing ever runs. '
        || 'Schedule them, add them to fn_ca_conservation_sweep, or exempt them '
        || 'with a reason in ca_check_sweep_exemptions. A check nobody runs '
        || 'reads as a check finding nothing.',
      false, jsonb_build_object('orphans', v_rows));
  END IF;
  RETURN COALESCE(v_n,0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_orphaned_checks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_orphaned_checks() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_orphaned_checks_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_orphaned_checks_watch() TO service_role;

COMMIT;

