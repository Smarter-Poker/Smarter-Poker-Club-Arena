-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503085545 "add_auth_health_view_2026_05_03i"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e1c5a899c8f6a92641b083e3d3901160 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- UNIFIED auth_health_view — aggregates all 4 auth-flow probes
-- ─────────────────────────────────────────────────────────────────────────
-- Powers /admin/auth-health (extends /admin/signup-health). One query
-- gives the on-call a complete picture across signup, login, recovery,
-- magic-link, integrity-audit, and email-deliverability flows.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.auth_health_view AS
WITH probe_counts AS (
    SELECT
        probe_name,
        count(*) FILTER (WHERE occurred_at > now() - interval '15 minutes') AS runs_15m,
        count(*) FILTER (WHERE occurred_at > now() - interval '1 hour') AS runs_1h,
        count(*) FILTER (WHERE occurred_at > now() - interval '24 hours') AS runs_24h,
        count(*) FILTER (WHERE occurred_at > now() - interval '15 minutes' AND status = 'ok') AS ok_15m,
        count(*) FILTER (WHERE occurred_at > now() - interval '1 hour' AND status = 'failed') AS failed_1h,
        max(occurred_at) AS last_run_at
    FROM public.probe_heartbeats
    GROUP BY probe_name
)
SELECT
    -- Signup flow (existing — preserved)
    COALESCE((SELECT runs_15m FROM probe_counts WHERE probe_name = 'signup-probe'), 0) AS signup_runs_15m,
    COALESCE((SELECT ok_15m FROM probe_counts WHERE probe_name = 'signup-probe'), 0) AS signup_ok_15m,
    COALESCE((SELECT failed_1h FROM probe_counts WHERE probe_name = 'signup-probe'), 0) AS signup_failed_1h,
    (SELECT last_run_at FROM probe_counts WHERE probe_name = 'signup-probe') AS signup_last_run,

    -- Login flow (new)
    COALESCE((SELECT runs_15m FROM probe_counts WHERE probe_name = 'login-probe'), 0) AS login_runs_15m,
    COALESCE((SELECT ok_15m FROM probe_counts WHERE probe_name = 'login-probe'), 0) AS login_ok_15m,
    COALESCE((SELECT failed_1h FROM probe_counts WHERE probe_name = 'login-probe'), 0) AS login_failed_1h,
    (SELECT last_run_at FROM probe_counts WHERE probe_name = 'login-probe') AS login_last_run,

    -- Recovery flow (password reset + magic link, both in one probe)
    COALESCE((SELECT runs_15m FROM probe_counts WHERE probe_name = 'recovery-probe'), 0) AS recovery_runs_15m,
    COALESCE((SELECT ok_15m FROM probe_counts WHERE probe_name = 'recovery-probe'), 0) AS recovery_ok_15m,
    COALESCE((SELECT failed_1h FROM probe_counts WHERE probe_name = 'recovery-probe'), 0) AS recovery_failed_1h,
    (SELECT last_run_at FROM probe_counts WHERE probe_name = 'recovery-probe') AS recovery_last_run,

    -- DB integrity audit (nightly)
    COALESCE((SELECT runs_24h FROM probe_counts WHERE probe_name = 'auth-integrity-audit'), 0) AS integrity_runs_24h,
    COALESCE((SELECT failed_1h FROM probe_counts WHERE probe_name = 'auth-integrity-audit'), 0) AS integrity_failed_1h,
    (SELECT last_run_at FROM probe_counts WHERE probe_name = 'auth-integrity-audit') AS integrity_last_run,

    -- Email deliverability (nightly)
    COALESCE((SELECT runs_24h FROM probe_counts WHERE probe_name = 'email-deliverability'), 0) AS email_runs_24h,
    COALESCE((SELECT failed_1h FROM probe_counts WHERE probe_name = 'email-deliverability'), 0) AS email_failed_1h,
    (SELECT last_run_at FROM probe_counts WHERE probe_name = 'email-deliverability') AS email_last_run,

    -- Real signups (carried over from signup_health_view)
    (SELECT new_users_24h FROM public.signup_health_view) AS real_signups_24h,
    (SELECT new_users_1h FROM public.signup_health_view) AS real_signups_1h,
    (SELECT errors_1h FROM public.signup_health_view) AS trigger_errors_1h,

    now() AS computed_at;

GRANT SELECT ON public.auth_health_view TO service_role;

COMMENT ON VIEW public.auth_health_view IS
  'Unified health snapshot across all auth flows. Powers /admin/auth-health. Each *_failed_1h column is the alert signal — non-zero = page on-call.';
