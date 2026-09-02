-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053713; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  CLIENT SHELL TELEMETRY (Dan 2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On 2026-08-29 the open-from-Hub "glitch and reload" was fixed: sw-bus.js
-- races the shell revalidation for 300ms so a post-deploy entry boots the
-- CURRENT bundle, and useShellUpdateGate verifies running-vs-deployed before
-- arming any reload. The client emits SHELL_STALENESS_CHECKED (both outcomes,
-- with a source) and SHELL_RELOADED (with page age) — and NOTHING READ THEM.
--
-- A fix nobody measures is a fix nobody can defend. This is the sink. The two
-- questions it exists to answer:
--   1. what share of staleness checks come back stale, per source? (near zero
--      on shell-updated/controllerchange means the SW race is winning)
--   2. are reloads still landing long after paint? (page_age_ms; a reload
--      inside the startup window is the fix working, a late one is the glitch)
--
-- Deliberately narrow: no free-form payload, no PII, six typed columns. It is
-- a KPI table, not an event lake.

CREATE TABLE IF NOT EXISTS public.client_shell_telemetry (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  event          text NOT NULL CHECK (event IN ('staleness_checked', 'reloaded')),
  -- staleness_checked only:
  stale          boolean,
  source         text CHECK (source IS NULL OR source IN ('shell-updated', 'controllerchange', 'resume-probe')),
  running_entry  text,
  deployed_entry text,
  -- reloaded only: ms from page start to the reload firing.
  page_age_ms    integer CHECK (page_age_ms IS NULL OR page_age_ms >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.client_shell_telemetry IS
  'KPI sink for the 2026-08-29 open-from-Hub glitch fix. Written by the Club Arena client (ShellTelemetryService); read by v_shell_staleness_rate.';

-- The only access pattern is "recent rows", so one index covers it.
CREATE INDEX IF NOT EXISTS client_shell_telemetry_created_idx
  ON public.client_shell_telemetry (created_at DESC);

ALTER TABLE public.client_shell_telemetry ENABLE ROW LEVEL SECURITY;

-- A signed-in client may append its OWN rows and nothing else. No select
-- policy: this is write-only from the browser: the dashboards read it with
-- the service role. A client that could read it back learns nothing useful
-- and gains a scraping surface.
DROP POLICY IF EXISTS client_shell_telemetry_insert_own ON public.client_shell_telemetry;
CREATE POLICY client_shell_telemetry_insert_own
  ON public.client_shell_telemetry
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ── THE KPI, AS ONE READ ───────────────────────────────────────────────────
-- Stale share per source per day. The fix is holding while `stale_pct` stays
-- near zero for shell-updated and controllerchange.
CREATE OR REPLACE VIEW public.v_shell_staleness_rate AS
SELECT
  date_trunc('day', created_at)                                    AS day,
  source,
  count(*)                                                         AS checks,
  count(*) FILTER (WHERE stale)                                    AS stale_checks,
  round(100.0 * count(*) FILTER (WHERE stale) / NULLIF(count(*), 0), 2) AS stale_pct
FROM public.client_shell_telemetry
WHERE event = 'staleness_checked'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON VIEW public.v_shell_staleness_rate IS
  'Share of shell staleness checks that came back stale, per source per day. Near-zero on shell-updated/controllerchange means the SW freshness race is winning and the boot-then-reload glitch is not recurring.';

-- Reloads that landed LATE are the glitch Dan reported; reloads inside the
-- startup window are the fix adopting a genuinely stale bundle cleanly.
CREATE OR REPLACE VIEW public.v_shell_reload_lateness AS
SELECT
  date_trunc('day', created_at)                                          AS day,
  count(*)                                                               AS reloads,
  count(*) FILTER (WHERE page_age_ms <= 15000)                           AS within_startup_window,
  count(*) FILTER (WHERE page_age_ms > 15000)                            AS after_paint,
  max(page_age_ms)                                                       AS worst_page_age_ms
FROM public.client_shell_telemetry
WHERE event = 'reloaded'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW public.v_shell_reload_lateness IS
  'Shell reloads per day split by whether they fired inside the 15s startup window (the fix working) or long after paint (the glitch Dan reported).';
