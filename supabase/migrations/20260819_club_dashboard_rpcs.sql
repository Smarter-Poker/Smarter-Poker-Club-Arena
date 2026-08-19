-- ============================================================================
-- 20260819_club_dashboard_rpcs.sql
-- Club Dashboard rebuild (Tier 2 migration -- additive only)
--
-- WHY: /hub/club-arena/clubs/:id/dashboard showed +0.00 for every player,
--   "No activity yet" forever, and Online Now = 0 while a table was running.
--   Root causes:
--   1. club_members.chips_won / chips_lost / hands_played are NEVER written
--      by anything (0 non-zero rows across 327 members of the busiest club),
--      yet the dashboard leaderboard reads them.
--   2. The club_activity table the activity feed queries DOES NOT EXIST.
--   3. Online Now reads club_members.last_active which nothing updates;
--      actual seat occupancy lives in table_seats (left_at IS NULL).
--   4. The Time Range filter was never wired to any query.
--   Real source of truth is hand_history (2.25M club hands), but a live
--   aggregate over one club costs ~3s -- too slow for page load.
--
-- WHAT THIS ADDS (no destructive changes):
--   1. club_member_daily_stats -- per (club, user, day) incremental
--      aggregates: hands, chips won, chips invested, biggest pot.
--   2. trg_hand_history_club_member_stats -- AFTER INSERT trigger on
--      hand_history that upserts the daily aggregates (exception-safe:
--      never blocks the engine's insert).
--   3. ca_backfill_club_member_stats(p_from, p_to) -- chunkable backfill
--      helper (service_role only).
--   4. ca_club_top_players(p_club_id, p_since, p_limit) -- leaderboard RPC
--      with real profit + hands and time-range support.
--   5. ca_club_dashboard_stats(p_club_id) -- one-shot stats RPC: members,
--      online now (live seats + recent activity), active tables, hands and
--      rake today, new members this week.
--   6. ca_club_activity(p_club_id, p_limit) -- synthesized activity feed
--      (member joins, announcements, big pots, table starts) from tables
--      that already exist, so the feed works without a new write path.
--
-- SECURITY: RPCs are SECURITY DEFINER, return aggregates only (no hole
--   cards). EXECUTE granted to authenticated + service_role, revoked from
--   anon/public. club_member_daily_stats has RLS enabled with no policies
--   (read path is the definer RPCs only).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS hand_history_club_member_stats ON public.hand_history;
--   DROP FUNCTION IF EXISTS public.trg_hand_history_club_member_stats();
--   DROP FUNCTION IF EXISTS public.ca_backfill_club_member_stats(date, date);
--   DROP FUNCTION IF EXISTS public.ca_club_top_players(uuid, timestamptz, int);
--   DROP FUNCTION IF EXISTS public.ca_club_dashboard_stats(uuid);
--   DROP FUNCTION IF EXISTS public.ca_club_activity(uuid, int);
--   DROP TABLE IF EXISTS public.club_member_daily_stats;
-- ============================================================================

-- ── 1. Incremental aggregates table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.club_member_daily_stats (
  club_id        uuid    NOT NULL,
  user_id        uuid    NOT NULL,
  stat_date      date    NOT NULL,
  hands_played   integer NOT NULL DEFAULT 0,
  total_won      numeric NOT NULL DEFAULT 0,
  total_invested numeric NOT NULL DEFAULT 0,
  biggest_pot    numeric NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_cmds_club_date
  ON public.club_member_daily_stats (club_id, stat_date);

ALTER TABLE public.club_member_daily_stats ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: all reads flow through the definer RPCs below.

-- ── 2. Trigger: maintain aggregates on every completed hand ─────────────────

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid;
BEGIN
  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO club_member_daily_stats AS s
    (club_id, user_id, stat_date, hands_played, total_won, total_invested, biggest_pot)
  SELECT
    v_club,
    (p.uid)::uuid,
    (NEW.created_at AT TIME ZONE 'UTC')::date,
    1,
    coalesce(w.won, 0),
    coalesce(a.invested, 0),
    coalesce(NEW.pot_size, 0)
  FROM (
    SELECT DISTINCT pl->>'userId' AS uid
    FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) pl
    WHERE (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) p
  LEFT JOIN LATERAL (
    SELECT sum((wn->>'amount')::numeric) AS won
    FROM jsonb_array_elements(coalesce(NEW.winners, '[]'::jsonb)) wn
    WHERE wn->>'userId' = p.uid
  ) w ON true
  LEFT JOIN LATERAL (
    SELECT sum(coalesce((ac->>'amount')::numeric, 0)) AS invested
    FROM jsonb_array_elements(coalesce(NEW.actions, '[]'::jsonb)) ac
    WHERE ac->>'userId' = p.uid
  ) a ON true
  ON CONFLICT (club_id, user_id, stat_date) DO UPDATE SET
    hands_played   = s.hands_played + 1,
    total_won      = s.total_won + EXCLUDED.total_won,
    total_invested = s.total_invested + EXCLUDED.total_invested,
    biggest_pot    = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    updated_at     = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Stats must never block the engine's hand insert.
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS hand_history_club_member_stats ON public.hand_history;
CREATE TRIGGER hand_history_club_member_stats
  AFTER INSERT ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION public.trg_hand_history_club_member_stats();

-- ── 3. Backfill helper (chunk by date window; service_role only) ────────────

CREATE OR REPLACE FUNCTION public.ca_backfill_club_member_stats(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO club_member_daily_stats AS s
    (club_id, user_id, stat_date, hands_played, total_won, total_invested, biggest_pot)
  SELECT
    t.club_id,
    (p.uid)::uuid,
    (hh.created_at AT TIME ZONE 'UTC')::date,
    count(*),
    coalesce(sum(p.won), 0),
    coalesce(sum(p.invested), 0),
    coalesce(max(hh.pot_size), 0)
  FROM hand_history hh
  JOIN tables t ON t.id = hh.table_id AND t.club_id IS NOT NULL
  CROSS JOIN LATERAL (
    SELECT
      pl->>'userId' AS uid,
      (SELECT sum((wn->>'amount')::numeric)
         FROM jsonb_array_elements(coalesce(hh.winners, '[]'::jsonb)) wn
        WHERE wn->>'userId' = pl->>'userId') AS won,
      (SELECT sum(coalesce((ac->>'amount')::numeric, 0))
         FROM jsonb_array_elements(coalesce(hh.actions, '[]'::jsonb)) ac
        WHERE ac->>'userId' = pl->>'userId') AS invested
    FROM jsonb_array_elements(coalesce(hh.players, '[]'::jsonb)) pl
    WHERE (pl->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) p
  WHERE hh.created_at >= p_from::timestamptz
    AND hh.created_at <  p_to::timestamptz
  GROUP BY t.club_id, p.uid, (hh.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, user_id, stat_date) DO UPDATE SET
    hands_played   = EXCLUDED.hands_played,
    total_won      = EXCLUDED.total_won,
    total_invested = EXCLUDED.total_invested,
    biggest_pot    = EXCLUDED.biggest_pot,
    updated_at     = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

-- ── 4. Leaderboard RPC ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_club_top_players(
  p_club_id uuid,
  p_since   timestamptz DEFAULT NULL,
  p_limit   integer     DEFAULT 50
)
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  avatar_url   text,
  hands_played bigint,
  total_won    numeric,
  profit       numeric,
  biggest_pot  numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    s.user_id,
    coalesce(pr.display_name, 'Player') AS display_name,
    pr.avatar_url,
    sum(s.hands_played)::bigint         AS hands_played,
    sum(s.total_won)                    AS total_won,
    sum(s.total_won) - sum(s.total_invested) AS profit,
    max(s.biggest_pot)                  AS biggest_pot
  FROM club_member_daily_stats s
  LEFT JOIN profiles pr ON pr.id = s.user_id
  WHERE s.club_id = p_club_id
    AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
  GROUP BY s.user_id, pr.display_name, pr.avatar_url
  ORDER BY profit DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
$fn$;

-- ── 5. One-shot dashboard stats RPC ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    -- NOTE: a table can be status='running' while is_deleted=true (engine
    -- keeps dealing). Running/waiting tables count as active regardless.
    'active_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND t.status IN ('running', 'waiting', 'active')
    ),
    'total_tables', (
      SELECT count(*) FROM tables t
      WHERE t.club_id = p_club_id
        AND (coalesce(t.is_deleted, false) = false OR t.status IN ('running', 'waiting', 'active'))
    ),
    'hands_today', coalesce((
      SELECT ds.hands_played FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), (
      SELECT count(*) FROM hand_history hh
      JOIN tables t ON t.id = hh.table_id
      WHERE t.club_id = p_club_id
        AND hh.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    )),
    'rake_today', coalesce((
      SELECT ds.rake_collected FROM club_daily_stats ds
      WHERE ds.club_id = p_club_id AND ds.stat_date = (now() AT TIME ZONE 'UTC')::date
    ), (
      SELECT coalesce(sum(hh.rake_amount), 0) FROM hand_history hh
      JOIN tables t ON t.id = hh.table_id
      WHERE t.club_id = p_club_id
        AND hh.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    )),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id
        AND cm.created_at > now() - interval '7 days'
    )
  );
$fn$;

-- ── 6. Activity feed RPC (synthesized from existing tables) ─────────────────

CREATE OR REPLACE FUNCTION public.ca_club_activity(
  p_club_id uuid,
  p_limit   integer DEFAULT 20
)
RETURNS TABLE (
  id            text,
  activity_type text,
  message       text,
  created_at    timestamptz,
  user_id       uuid,
  display_name  text,
  avatar_url    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH events AS (
    -- Member joins (last 30 days)
    (SELECT
       'join-' || cm.user_id::text AS id,
       'member_join'::text         AS activity_type,
       'joined the club'::text     AS message,
       cm.created_at,
       cm.user_id
     FROM club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.created_at > now() - interval '30 days'
     ORDER BY cm.created_at DESC
     LIMIT 50)
    UNION ALL
    -- Announcements (last 30 days)
    (SELECT
       'ann-' || an.id::text,
       'announcement',
       coalesce(nullif(an.title, ''), left(coalesce(an.content, an.message, 'New announcement'), 120)),
       an.created_at,
       coalesce(an.author_id, an.created_by)
     FROM club_announcements an
     WHERE an.club_id = p_club_id
       AND an.created_at > now() - interval '30 days'
       AND coalesce(an.is_active, true)
     ORDER BY an.created_at DESC
     LIMIT 20)
    UNION ALL
    -- Big pots (last 48 hours, pot >= 40 big blinds)
    (SELECT
       'hand-' || hh.id::text,
       'big_hand',
       'won a ' || to_char(coalesce(hh.pot_size, 0), 'FM999,999,990.00') || ' pot'
         || CASE WHEN hh.hand_name IS NOT NULL THEN ' with ' || hh.hand_name ELSE '' END,
       hh.created_at,
       CASE
         WHEN (hh.winners->0->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (hh.winners->0->>'userId')::uuid
         ELSE NULL
       END
     FROM hand_history hh
     JOIN tables t ON t.id = hh.table_id
     WHERE t.club_id = p_club_id
       AND hh.created_at > now() - interval '48 hours'
       AND coalesce(hh.pot_size, 0) >= 40 * greatest(coalesce(hh.big_blind, 0.02), 0.02)
     ORDER BY hh.created_at DESC
     LIMIT 30)
    UNION ALL
    -- Table starts (last 7 days)
    (SELECT
       'table-' || t.id::text,
       'table_start',
       'Table "' || coalesce(t.name, 'Unnamed') || '" was created',
       t.created_at,
       t.created_by
     FROM tables t
     WHERE t.club_id = p_club_id
       AND t.created_at > now() - interval '7 days'
       AND coalesce(t.is_deleted, false) = false
     ORDER BY t.created_at DESC
     LIMIT 10)
  )
  SELECT
    e.id, e.activity_type, e.message, e.created_at, e.user_id,
    pr.display_name, pr.avatar_url
  FROM events e
  LEFT JOIN profiles pr ON pr.id = e.user_id
  ORDER BY e.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100);
$fn$;

-- ── 7. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_club_dashboard_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_club_activity(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_backfill_club_member_stats(date, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_dashboard_stats(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_activity(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_backfill_club_member_stats(date, date) TO service_role;

-- Post-apply assertions
DO $$
BEGIN
  IF to_regclass('public.club_member_daily_stats') IS NULL THEN
    RAISE EXCEPTION 'club_member_daily_stats was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'hand_history_club_member_stats'
  ) THEN
    RAISE EXCEPTION 'hand_history_club_member_stats trigger missing';
  END IF;
END $$;
