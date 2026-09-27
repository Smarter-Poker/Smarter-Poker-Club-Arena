-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503075016 "add_probe_heartbeats_2026_05_03d"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e14b43f08d55373716f479f650a9cf70 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BUG FIX (2026-05-03d): probe_runs_* in signup_health_view always = 0
-- ─────────────────────────────────────────────────────────────────────────
-- Reason: the probe creates a user, verifies the trigger row, then
-- DELETES the user. By the time the view runs, the probe user is gone, so
-- counting "auth.users where email LIKE probe-%" always returns 0 — the
-- exact "dashboard says green while system is broken" failure mode we're
-- trying to prevent.
--
-- Fix: dedicated heartbeat table that the probe INSERTs into before
-- cleanup. View reads from there. Old rows trimmed by a daily cron.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.probe_heartbeats (
  id          bigserial PRIMARY KEY,
  probe_name  text NOT NULL DEFAULT 'signup-probe',
  status      text NOT NULL CHECK (status IN ('ok', 'failed', 'partial')),
  duration_ms int,
  details     jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS probe_heartbeats_occurred_idx
  ON public.probe_heartbeats (occurred_at DESC);
CREATE INDEX IF NOT EXISTS probe_heartbeats_name_occurred_idx
  ON public.probe_heartbeats (probe_name, occurred_at DESC);

ALTER TABLE public.probe_heartbeats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS probe_heartbeats_service_only ON public.probe_heartbeats;
CREATE POLICY probe_heartbeats_service_only
  ON public.probe_heartbeats FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.probe_heartbeats IS
  'Append-only heartbeat record from /api/cron/signup-probe. One row per probe run, status reflects whether all 4 trigger rows came back. View signup_health_view aggregates last 15m / 1h. Trim by a daily cron (older than 7 days).';

-- ── Replace view to read heartbeats from the dedicated table ──────────────
DROP VIEW IF EXISTS public.signup_health_view;

CREATE VIEW public.signup_health_view AS
WITH real_users AS (
    SELECT created_at FROM auth.users
    WHERE email NOT LIKE 'probe-%@probe.smarter.poker'
      AND email NOT LIKE 'probe-%@probe.smarter.local'
)
SELECT
    -- REAL USER counts (the dashboard headline)
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '15 minutes') AS new_users_15m,
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '1 hour')     AS new_users_1h,
    (SELECT count(*) FROM real_users WHERE created_at > now() - interval '24 hours')   AS new_users_24h,
    (SELECT max(created_at) FROM real_users) AS last_signup_at,

    -- PROBE-OWN health (from heartbeats — survives probe cleanup)
    (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at > now() - interval '15 minutes') AS probe_runs_15m,
    (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at > now() - interval '1 hour')     AS probe_runs_1h,
    (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at > now() - interval '15 minutes' AND status = 'ok') AS probe_ok_15m,
    (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at > now() - interval '1 hour' AND status = 'failed') AS probe_failed_1h,
    (SELECT max(occurred_at) FROM public.probe_heartbeats) AS last_probe_at,

    -- Trigger errors
    (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '1 hour') AS errors_1h,
    (SELECT count(*) FROM public.signup_errors WHERE occurred_at > now() - interval '24 hours') AS errors_24h,
    (SELECT max(occurred_at) FROM public.signup_errors) AS last_error_at;

GRANT SELECT ON public.signup_health_view TO service_role;
