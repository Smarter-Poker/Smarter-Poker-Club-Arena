-- ============================================================================
-- 20260819j_club_hand_daily_rollup.sql
-- Club Dashboard — exact Hands Today / Rake Today (Tier 2, additive)
--
-- Applied to production as:
--   club_dashboard_hand_daily_rollup
--   club_dashboard_hand_daily_wire_trigger_and_stats
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- "Hands Today" and "Rake Today" read club_daily_stats, which lags badly.
-- Measured on Midway Union: the card showed 10,195 hands for today while
-- hand_history actually held 28,195 for that club — a 64% under-report on the
-- dashboard's most prominent metric. The earlier coalesce fallback never
-- helped, because club_daily_stats HAS a row for today; the row is simply
-- stale, so there was nothing for the fallback to catch.
--
-- ── WHY NOT JUST COUNT hand_history ────────────────────────────────────────
-- Measured: 2.75s and ~30k buffers for a single club-day, because it fans out
-- across every table of the club. This RPC runs on page load, so that is not
-- viable.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Maintain the rollup where the data arrives: the same AFTER INSERT trigger
-- that already resolves the club for every hand now also upserts one row per
-- (club, day). Exact by construction, O(1) per hand, on a table of a few rows
-- per club.
--
-- The rollup upsert is placed FIRST and outside the player-stats CTE chain, so
-- a hand whose players[] payload is malformed still counts — it still happened
-- and still paid rake.
--
-- club_daily_stats is left untouched (other surfaces read it) and remains the
-- fallback for dates predating this rollup, so historical series still render.
--
-- ── VERIFIED ───────────────────────────────────────────────────────────────
-- After backfilling Midway Union's week: hands_today 28,836 against a live
-- truth count of 28,856 — the 20-hand gap is hands dealt between the two
-- queries, and the trigger closes it continuously (observed climbing to
-- 29,111 shortly after). Previously 10,195 vs 28,195.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_backfill_club_hand_daily(uuid, date);
--   DROP TABLE IF EXISTS public.club_hand_daily;
--   re-apply ca_club_dashboard_stats + the trigger from
--   20260819i_club_dashboard_conservation_first.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.club_hand_daily (
  club_id      uuid NOT NULL,
  stat_date    date NOT NULL,
  hands        bigint  NOT NULL DEFAULT 0,
  rake         numeric NOT NULL DEFAULT 0,
  bbj          numeric NOT NULL DEFAULT 0,
  pot_total    numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, stat_date)
);

ALTER TABLE public.club_hand_daily ENABLE ROW LEVEL SECURITY;
-- No policies: read exclusively through ca_club_dashboard_stats, which
-- enforces club membership itself.

-- Backfill one (club, day). Deliberately one day at a time: the full range in
-- a single statement exceeds any workable timeout on the largest clubs.
--
-- The current day is GUARDED. This writes an ABSOLUTE count taken from a
-- snapshot, so any hand dealt while it runs is discarded along with the
-- trigger increment that already recorded it — observed leaving Midway Union
-- exactly 20 hands short, with a second run during a quieter moment coming
-- back exact (29,905 = 29,905). Past days are immutable and safe to rewrite;
-- today is owned by the trigger and is exact from the first hand of the day,
-- so overwriting it can only lose data. Normal operation is to backfill
-- history only; from the next UTC midnight the trigger owns every day end to
-- end and no backfill is needed at all.
CREATE OR REPLACE FUNCTION public.ca_backfill_club_hand_daily(
  p_club_id uuid,
  p_date    date,
  p_force   boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_hands bigint;
BEGIN
  IF p_date >= (now() AT TIME ZONE 'UTC')::date AND NOT coalesce(p_force, false) THEN
    RAISE EXCEPTION
      'refusing to overwrite the current day (%) — the trigger maintains it exactly; pass p_force => true only if you know it has drifted',
      p_date
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO club_hand_daily AS d (club_id, stat_date, hands, rake, bbj, pot_total)
  SELECT p_club_id, p_date,
         count(*),
         coalesce(sum(hh.rake_amount), 0),
         coalesce(sum(hh.bbj_amount), 0),
         coalesce(sum(hh.pot_size), 0)
  FROM hand_history hh
  JOIN tables t ON t.id = hh.table_id
  WHERE t.club_id = p_club_id
    AND hh.created_at >= p_date::timestamp AT TIME ZONE 'UTC'
    AND hh.created_at <  (p_date + 1)::timestamp AT TIME ZONE 'UTC'
  HAVING count(*) > 0
  ON CONFLICT (club_id, stat_date) DO UPDATE SET
    hands = EXCLUDED.hands, rake = EXCLUDED.rake, bbj = EXCLUDED.bbj,
    pot_total = EXCLUDED.pot_total, updated_at = now();

  SELECT hands INTO v_hands FROM club_hand_daily
   WHERE club_id = p_club_id AND stat_date = p_date;
  RETURN coalesce(v_hands, 0);
END;
$fn$;

DROP FUNCTION IF EXISTS public.ca_backfill_club_hand_daily(uuid, date);
REVOKE ALL ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) TO service_role;

-- ── Stats RPC reads the rollup first, club_daily_stats only as fallback ─────

CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total_members', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
    ),
    'online_now', (
      SELECT count(*) FROM (
        SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
        WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
        WHERE cm.club_id = p_club_id
          AND cm.last_active > now() - interval '15 minutes'
      ) x
    ),
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    'hands_today', coalesce(
      (SELECT d.hands FROM club_hand_daily d
        WHERE d.club_id = p_club_id AND d.stat_date = (now() AT TIME ZONE 'UTC')::date),
      (SELECT ds.hands_played FROM club_daily_stats ds
        WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date),
      0),
    'rake_today', coalesce(
      (SELECT d.rake FROM club_hand_daily d
        WHERE d.club_id = p_club_id AND d.stat_date = (now() AT TIME ZONE 'UTC')::date),
      (SELECT ds.rake_collected FROM club_daily_stats ds
        WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date),
      0),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', coalesce((
      SELECT sum(coalesce(d.hands, ds.hands_played, 0))
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 6,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), 0),
    'rake_week', coalesce((
      SELECT sum(coalesce(d.rake, ds.rake_collected, 0))
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 6,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), 0),
    'seated_now', (
      SELECT count(*) FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL
    ),
    'daily_series', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, ds.hands_played, 0),
               'rake',  coalesce(d.rake,  ds.rake_collected, 0))
             ORDER BY g.day)
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 13,
                           (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN club_daily_stats ds ON ds.club_id = p_club_id AND ds.stat_date = g.day::date
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;

-- NOTE: the trigger body that maintains club_hand_daily ships in the same
-- production migration; it is the conservation-first trigger from
-- 20260819i with the club_hand_daily upsert added ahead of the player CTEs.
