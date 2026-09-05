-- 20260905071929_card_slide_adoption_reads_its_caller.sql
--
-- Applied to production 2026-09-05 (version recorded by the Supabase MCP).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260905071659 admin-gated this routine, and `check-telemetry-exposure.mjs`
-- STILL failed it. The guard reads the function's OWN body for a consultation
-- of auth.uid() / auth.role() / auth.jwt(); mine delegated the whole question
-- to `fn_is_platform_admin()`, so from the outside it remained a definer
-- routine that never looks at its caller.
--
-- The guard is right to read it that way. "It calls something that checks"
-- is a property of the helper on the day you wrote it, and a later edit to
-- that helper silently changes what this routine enforces. So the identity
-- check is stated HERE, in the body that has the definer rights:
--
--   no session          -> no answer
--   session, not admin  -> empty result, not an error (a non-admin opening an
--                          admin panel is a UI state, not an incident)
--
-- Verified locally after applying:
--   $ node scripts/ci/check-telemetry-exposure.mjs
--   [telemetry-exposure] no unscoped operator routine is reachable from a browser.
--   EXIT=0

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
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RETURN;
  END IF;
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
