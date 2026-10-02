-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503074738 "harden_signup_view_exclude_probes_2026_05_03c"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4938335a4873604c044f567897c2fe98 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Drop and recreate (CREATE OR REPLACE VIEW can't reorder columns)
DROP VIEW IF EXISTS public.signup_health_view;

CREATE VIEW public.signup_health_view AS
WITH real_users AS (
    SELECT created_at FROM auth.users
    WHERE email NOT LIKE 'probe-%@probe.smarter.poker'
      AND email NOT LIKE 'probe-%@probe.smarter.local'
),
probe_users AS (
    SELECT created_at FROM auth.users
    WHERE email LIKE 'probe-%@probe.smarter.poker'
       OR email LIKE 'probe-%@probe.smarter.local'
)
SELECT
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '15 minutes') AS new_users_15m,
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '1 hour')     AS new_users_1h,
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '24 hours')   AS new_users_24h,
    (SELECT max(created_at) FROM real_users) AS last_signup_at,
    (SELECT count(*) FROM probe_users WHERE created_at > now() - interval '15 minutes') AS probe_runs_15m,
    (SELECT count(*) FROM probe_users WHERE created_at > now() - interval '1 hour')     AS probe_runs_1h,
    (SELECT max(created_at) FROM probe_users) AS last_probe_at,
    (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '1 hour') AS errors_1h,
    (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '24 hours') AS errors_24h,
    (SELECT max(occurred_at) FROM public.signup_errors) AS last_error_at;

COMMENT ON VIEW public.signup_health_view IS
  'Single-row health view powering /api/health/signup. new_users_* counts EXCLUDE synthetic probes (probe-*@probe.smarter.poker / probe.smarter.local). probe_runs_* surfaces probe activity separately so we can detect a stalled probe.';

GRANT SELECT ON public.signup_health_view TO service_role;
