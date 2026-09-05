-- 20260905071659_card_slide_adoption_is_admin_only.sql
--
-- Version reserved by scripts/new-migration.mjs, then re-stamped to the version
-- the Supabase MCP recorded when it was applied to production (2026-09-05).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- CI caught this, not review. `Telemetry Exposure` failed the build on
-- 41ae07b65 with:
--
--   [telemetry-exposure] FAILED: the operator console is open to the browser.
--   These are SECURITY DEFINER, take no identity argument, never look at who
--   is calling, and a logged-in account can execute them:
--     fn_card_slide_adoption   volatile  anon + authenticated
--
-- The routine returns AGGREGATES ONLY, and I had reasoned that made it safe to
-- hand to any logged-in browser. The guard does not care, and it is right not
-- to: it tests the SHAPE of the routine - definer rights, no identity
-- argument, no look at the caller - because that shape is what an operator
-- console is, and "it only returns totals today" is a property of this
-- version of the body, not of the grant. The grant outlives the body.
--
-- So the routine now asks who is calling. Platform admins get the numbers;
-- everyone else gets an empty result rather than an error, because an
-- authenticated non-admin hitting an admin panel is a UI state, not an
-- incident. anon loses EXECUTE entirely.
--
-- This is the readout behind the Card Slide panel in the admin Analytics tab.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_card_slide_adoption(p_days integer DEFAULT 7)
RETURNS TABLE (
  days integer,
  users_with_setting_on bigint,
  users_with_setting_off bigint,
  active_users bigint,
  peels_started bigint,
  peels_committed bigint,
  peels_abandoned bigint,
  keyboard_opens bigint,
  commit_rate numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH usage AS (
    SELECT
      COUNT(DISTINCT u.user_id) AS active_users,
      COALESCE(SUM(u.peels_started), 0) AS started,
      COALESCE(SUM(u.peels_committed), 0) AS committed,
      COALESCE(SUM(u.peels_abandoned), 0) AS abandoned,
      COALESCE(SUM(u.keyboard_opens), 0) AS keyboard
    FROM public.card_slide_usage u
    WHERE u.day >= (now() AT TIME ZONE 'utc')::date - v_days
  ),
  setting AS (
    SELECT
      COUNT(*) FILTER (WHERE s.card_slide) AS on_count,
      COUNT(*) FILTER (WHERE NOT s.card_slide) AS off_count
    FROM public.user_table_settings s
  )
  SELECT
    v_days,
    setting.on_count,
    setting.off_count,
    usage.active_users,
    usage.started,
    usage.committed,
    usage.abandoned,
    usage.keyboard,
    CASE WHEN usage.started > 0
      THEN ROUND((usage.committed::numeric / usage.started) * 100, 1)
      ELSE NULL
    END
  FROM usage, setting;
END $$;

REVOKE ALL ON FUNCTION public.fn_card_slide_adoption(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_card_slide_adoption(integer) TO authenticated;

COMMIT;
