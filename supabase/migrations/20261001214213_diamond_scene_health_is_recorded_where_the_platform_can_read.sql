-- 20261001214213_diamond_scene_health_is_recorded_where_the_platform_can_read.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The mobile graphics programme (2026-10-01) gave every Diamond scene visit a
-- one-line summary of how the device drew it (src/components/games/
-- sceneTelemetry.ts): frames a second while moving, the share of slow frames,
-- the quality tier it started and ended on, whether the CPU drew it, and a
-- report when a scene could not draw at all. Those summaries went only to
-- src/lib/analytics.ts, which sends nothing unless VITE_POSTHOG_KEY is set,
-- and no build of this platform has ever set it. The verification pass found
-- every summary was being dropped on the floor: the question the programme
-- exists to answer, "how do real phones draw the games", had no answer.
--
-- SHAPE: a DAILY ROLLUP with NO USER IN IT. One row per day, game, kind of
-- device, renderer and final quality tier, with counters added by the client
-- once per visit. Nothing in it names a player, so it is a device report, not
-- a usage log, and it stays tiny: four games times five device kinds times a
-- handful of tiers is the whole day.
--
-- The client is a browser and cannot be trusted with its numbers, so the
-- write CLAMPS every value and refuses anything outside the known games,
-- devices and failure reasons. A liar can skew a counter; it cannot corrupt
-- the table, and this is a product signal, never money.
--
-- RLS: on, with no policy. Nothing reaches the table except the two SECURITY
-- DEFINER functions below: the write, which only adds to counters, and the
-- read, which answers platform admins and returns nothing to anyone else (the
-- same contract as fn_card_slide_adoption, which the admin panel beside it
-- already reads).

BEGIN;

CREATE TABLE IF NOT EXISTS public.diamond_scene_daily (
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  game text NOT NULL CHECK (game IN ('crash', 'plinko', 'crossing', 'wheel')),
  device text NOT NULL CHECK (device IN ('app_ios', 'app_android', 'ios_web', 'android_web', 'desktop')),
  software boolean NOT NULL DEFAULT false,
  end_tier smallint NOT NULL DEFAULT 0 CHECK (end_tier BETWEEN 0 AND 5),
  sessions integer NOT NULL DEFAULT 0,
  moving_frames bigint NOT NULL DEFAULT 0,
  moving_ms bigint NOT NULL DEFAULT 0,
  slow_frames bigint NOT NULL DEFAULT 0,
  failed_renderer integer NOT NULL DEFAULT 0,
  failed_context_lost integer NOT NULL DEFAULT 0,
  failed_stalled integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, game, device, software, end_tier)
);

COMMENT ON TABLE public.diamond_scene_daily IS
  'Daily rollup of how devices drew the Diamond scenes, with no user in it. Written only by fn_record_diamond_scene; read only by fn_diamond_scene_health (platform admins).';

ALTER TABLE public.diamond_scene_daily ENABLE ROW LEVEL SECURITY;

-- The write. One call per scene visit (its summary) or per scene that could
-- not draw (p_failure). Counters are added, never set.
CREATE OR REPLACE FUNCTION public.fn_record_diamond_scene(
  p_game text,
  p_device text,
  p_software boolean DEFAULT false,
  p_end_tier integer DEFAULT 0,
  p_frames integer DEFAULT 0,
  p_ms integer DEFAULT 0,
  p_slow integer DEFAULT 0,
  p_failure text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- One visit is at most an hour of motion at a high refresh rate.
  v_frames integer := LEAST(GREATEST(COALESCE(p_frames, 0), 0), 500000);
  v_ms integer := LEAST(GREATEST(COALESCE(p_ms, 0), 0), 3600000);
  v_slow integer;
  v_tier smallint := LEAST(GREATEST(COALESCE(p_end_tier, 0), 0), 5)::smallint;
  v_failure text := NULLIF(p_failure, '');
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('crash', 'plinko', 'crossing', 'wheel') THEN
    RETURN;
  END IF;
  IF p_device IS NULL OR p_device NOT IN ('app_ios', 'app_android', 'ios_web', 'android_web', 'desktop') THEN
    RETURN;
  END IF;
  IF v_failure IS NOT NULL AND v_failure NOT IN ('renderer', 'context_lost', 'stalled') THEN
    RETURN;
  END IF;
  v_slow := LEAST(GREATEST(COALESCE(p_slow, 0), 0), v_frames);
  IF v_failure IS NULL AND (v_frames = 0 OR v_ms = 0) THEN
    RETURN;
  END IF;

  INSERT INTO public.diamond_scene_daily AS d (
    day, game, device, software, end_tier, sessions, moving_frames, moving_ms, slow_frames,
    failed_renderer, failed_context_lost, failed_stalled
  )
  VALUES (
    (now() AT TIME ZONE 'utc')::date, p_game, p_device, COALESCE(p_software, false), v_tier,
    CASE WHEN v_failure IS NULL THEN 1 ELSE 0 END,
    CASE WHEN v_failure IS NULL THEN v_frames ELSE 0 END,
    CASE WHEN v_failure IS NULL THEN v_ms ELSE 0 END,
    CASE WHEN v_failure IS NULL THEN v_slow ELSE 0 END,
    CASE WHEN v_failure = 'renderer' THEN 1 ELSE 0 END,
    CASE WHEN v_failure = 'context_lost' THEN 1 ELSE 0 END,
    CASE WHEN v_failure = 'stalled' THEN 1 ELSE 0 END
  )
  ON CONFLICT (day, game, device, software, end_tier) DO UPDATE SET
    sessions = d.sessions + EXCLUDED.sessions,
    moving_frames = d.moving_frames + EXCLUDED.moving_frames,
    moving_ms = d.moving_ms + EXCLUDED.moving_ms,
    slow_frames = d.slow_frames + EXCLUDED.slow_frames,
    failed_renderer = d.failed_renderer + EXCLUDED.failed_renderer,
    failed_context_lost = d.failed_context_lost + EXCLUDED.failed_context_lost,
    failed_stalled = d.failed_stalled + EXCLUDED.failed_stalled,
    updated_at = now();
END $$;

REVOKE ALL ON FUNCTION public.fn_record_diamond_scene(text, text, boolean, integer, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_diamond_scene(text, text, boolean, integer, integer, integer, integer, text) TO authenticated;

-- The read. Platform admins only; anyone else gets an empty result, because a
-- non-admin opening an admin panel is a UI state, not an incident.
CREATE OR REPLACE FUNCTION public.fn_diamond_scene_health(p_days integer DEFAULT 7)
RETURNS TABLE (
  game text,
  device text,
  sessions bigint,
  fps numeric,
  slow_share numeric,
  lite_share numeric,
  software_share numeric,
  failures bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    d.game,
    d.device,
    SUM(d.sessions)::bigint,
    CASE WHEN SUM(d.moving_ms) > 0
      THEN ROUND(SUM(d.moving_frames) * 1000.0 / SUM(d.moving_ms), 1) END,
    CASE WHEN SUM(d.moving_frames) > 0
      THEN ROUND(SUM(d.slow_frames) * 100.0 / SUM(d.moving_frames), 1) END,
    CASE WHEN SUM(d.sessions) > 0
      THEN ROUND(COALESCE(SUM(d.sessions) FILTER (WHERE d.end_tier > 0), 0) * 100.0 / SUM(d.sessions), 1) END,
    CASE WHEN SUM(d.sessions) > 0
      THEN ROUND(COALESCE(SUM(d.sessions) FILTER (WHERE d.software), 0) * 100.0 / SUM(d.sessions), 1) END,
    SUM(d.failed_renderer + d.failed_context_lost + d.failed_stalled)::bigint
  FROM public.diamond_scene_daily d
  WHERE d.day >= (now() AT TIME ZONE 'utc')::date - v_days
  GROUP BY d.game, d.device
  ORDER BY d.game, d.device;
END $$;

REVOKE ALL ON FUNCTION public.fn_diamond_scene_health(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_diamond_scene_health(integer) TO authenticated;

COMMIT;
