-- 20260905065636_card_slide_usage_telemetry.sql
--
-- Version reserved by scripts/new-migration.mjs, then re-stamped to the version
-- the Supabase MCP recorded when it was applied to production (2026-09-05).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-09-05, on measuring the Card Slide corner peel: "ADD THIS TO THE
-- ADMIN PANEL SOMEWHERE."
--
-- Without measurement there is no way to answer the only questions that
-- matter about the feature: do players turn it on, and once on, do they
-- actually complete the gesture or give up half way. The commit threshold
-- (45% of the card's diagonal) was chosen by feel; the abandon rate is what
-- says whether the feel was right.
--
-- SHAPE: a DAILY ROLLUP PER USER, not an event log. A peel happens on most
-- hands, and this platform deals ~221k hands a day - an event row each would
-- add a table larger than hand_history for a counter. One row per user per
-- day, incremented in batches by the client, answers every question above at
-- a thousandth of the write volume.
--
-- The client cannot be trusted with the numbers it sends (it is a browser),
-- so the RPC CLAMPS every counter per call. A liar can still inflate its own
-- row; it cannot corrupt the table or anyone else's row, and the metric is a
-- product signal rather than money.
--
-- RLS: on, with no policy. Nothing reaches this table except the two
-- SECURITY DEFINER functions below - the write, which can only ever touch
-- auth.uid()'s own row, and the read, which returns AGGREGATES ONLY and
-- never a per-user row.

BEGIN;

CREATE TABLE IF NOT EXISTS public.card_slide_usage (
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  peels_started integer NOT NULL DEFAULT 0,
  peels_committed integer NOT NULL DEFAULT 0,
  peels_abandoned integer NOT NULL DEFAULT 0,
  keyboard_opens integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id)
);

COMMENT ON TABLE public.card_slide_usage IS
  'Daily per-user rollup of Card Slide corner-peel usage. Written only by fn_record_card_slide_usage; read in aggregate by fn_card_slide_adoption.';

ALTER TABLE public.card_slide_usage ENABLE ROW LEVEL SECURITY;

-- The write. Counters are added, never set, so a retry after a dropped
-- response double-counts at worst - which is the right failure for a metric,
-- versus losing a day's data to a lost write.
CREATE OR REPLACE FUNCTION public.fn_record_card_slide_usage(
  p_started integer DEFAULT 0,
  p_committed integer DEFAULT 0,
  p_abandoned integer DEFAULT 0,
  p_keyboard integer DEFAULT 0
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  -- One flush covers at most a few minutes of play. 500 of anything in a
  -- single call is not a person peeling cards.
  v_started integer := LEAST(GREATEST(COALESCE(p_started, 0), 0), 500);
  v_committed integer := LEAST(GREATEST(COALESCE(p_committed, 0), 0), 500);
  v_abandoned integer := LEAST(GREATEST(COALESCE(p_abandoned, 0), 0), 500);
  v_keyboard integer := LEAST(GREATEST(COALESCE(p_keyboard, 0), 0), 500);
BEGIN
  IF v_user IS NULL THEN
    RETURN;
  END IF;
  IF v_started + v_committed + v_abandoned + v_keyboard = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.card_slide_usage AS c (
    day, user_id, peels_started, peels_committed, peels_abandoned, keyboard_opens
  )
  VALUES (
    (now() AT TIME ZONE 'utc')::date, v_user, v_started, v_committed, v_abandoned, v_keyboard
  )
  ON CONFLICT (day, user_id) DO UPDATE SET
    peels_started = c.peels_started + EXCLUDED.peels_started,
    peels_committed = c.peels_committed + EXCLUDED.peels_committed,
    peels_abandoned = c.peels_abandoned + EXCLUDED.peels_abandoned,
    keyboard_opens = c.keyboard_opens + EXCLUDED.keyboard_opens,
    updated_at = now();
END $$;

REVOKE ALL ON FUNCTION public.fn_record_card_slide_usage(integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_record_card_slide_usage(integer, integer, integer, integer) TO authenticated;

-- The read. AGGREGATES ONLY: this answers "is the feature working" and can
-- never answer "what did that player do", which is not an admin's business
-- and would make the table a surveillance log rather than a metric.
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH win AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 7), 1), 90) AS d
  ),
  usage AS (
    SELECT
      COUNT(DISTINCT u.user_id) AS active_users,
      COALESCE(SUM(u.peels_started), 0) AS started,
      COALESCE(SUM(u.peels_committed), 0) AS committed,
      COALESCE(SUM(u.peels_abandoned), 0) AS abandoned,
      COALESCE(SUM(u.keyboard_opens), 0) AS keyboard
    FROM public.card_slide_usage u, win
    WHERE u.day >= (now() AT TIME ZONE 'utc')::date - win.d
  ),
  setting AS (
    SELECT
      COUNT(*) FILTER (WHERE s.card_slide) AS on_count,
      COUNT(*) FILTER (WHERE NOT s.card_slide) AS off_count
    FROM public.user_table_settings s
  )
  SELECT
    win.d,
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
  FROM win, usage, setting;
$$;

REVOKE ALL ON FUNCTION public.fn_card_slide_adoption(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_card_slide_adoption(integer) TO authenticated;

COMMIT;
