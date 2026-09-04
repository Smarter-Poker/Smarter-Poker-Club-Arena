-- THE DASHBOARD COUNTS WHAT IS THERE.
--
-- Phase 4 of Dan's Club Operations upgrade: the club dashboard at
-- /clubs/:id/dashboard-full. Five of its readings were confirmed wrong
-- against production on 2026-09-03 (docs/club-operations/OPERATIONS-UPGRADE-
-- PLAN.md section 6) and re-measured on 2026-09-04 before this was written.
-- Every figure below is from Deep Stack Society (2a1132b9) on 2026-09-04.
--
-- 1. THE TABLES TAB HIDES MOST OF THE LIVE TABLES. The page fetches the 50
--    newest tables by created_at and computes "N Live, M Seated" over those
--    50. The club has 4,954 tables and 319 live. On 2026-09-03 zero of the
--    226 then-live tables were in the newest 50; on 2026-09-04 all 50 of the
--    newest happen to be live, which means the tab shows 50 of 319 under a
--    header that says 319. Either way the number in the header and the rows
--    beneath it are computed over different sets. There was no RPC for
--    tables; ca_club_tables below is the first, and it counts seats from
--    table_seats rather than trusting tables.current_players, which disagrees
--    with the seat rows on 28 of the 319 live tables (449 against 477).
--
-- 2. "SEATED NOW" COUNTS SEAT ROWS, NOT PEOPLE. ca_club_dashboard_stats
--    returns count(*) over table_seats with left_at IS NULL: 479 today, for
--    243 distinct people. Phase 1's ca_club_operations_overview already counts
--    people, which is why this page and /operations have never agreed at the
--    same instant. Fixed to count(DISTINCT user_id).
--
-- 3. THE LEADERBOARD SORTS A PRE-TRUNCATED SET. ca_club_top_players orders
--    by profit and takes 100; the page then re-sorts those 100 by Hands or
--    Win Rate. Over this week's 678 players, the ten the page shows under
--    "Hands" share ZERO members with the true top ten by hands, and "Win Rate"
--    shares three. The function now takes p_sort and orders by the chosen
--    key before the LIMIT, so what is shown as the top ten by hands is the
--    top ten by hands.
--
-- 4. ca_club_tournaments IGNORES p_limit. The LIMIT sits after jsonb_agg,
--    which is a single row, so it limits nothing. Asked for 25, the function
--    returns 3,534 finished tournaments in 879,696 bytes. The LIMIT now
--    applies inside a subquery before the aggregate. The 30-day window was
--    also hardcoded while the page's Time Range filter sat above it doing
--    nothing; it is now p_days, and the summary keys say which window they
--    describe.
--
-- 5. REVENUE IS READABLE BY EVERY MEMBER. ca_club_revenue gates on
--    ca_can_view_club, which any non-banned member satisfies, so a plain
--    player can read the club's rake, bad beat drop and insurance net. Every
--    other finance read on this estate (the insurance report, club data) uses
--    ca_can_view_club_finances (owner / co_owner / admin / super_agent). This
--    one now does too. Same signature, same payload.
--
-- Signature changes: ca_club_top_players gains p_sort and ca_club_tournaments
-- gains p_days. Both are DROPped and recreated rather than CREATE OR REPLACEd,
-- because a new parameter list makes a new overload and PostgREST would then
-- see two candidates. Both new parameters carry defaults so the existing
-- named-argument calls resolve unchanged. No other function on the database
-- calls either (checked pg_proc.prosrc on 2026-09-04).
--
-- Horses are counted like every other player (CLAUDE.md 10.5). Nothing here
-- reads is_horse except to return it as data, masked by fn_can_see_horse_flag
-- exactly as before.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
--  1. ca_club_tables: the tables tab reads the tables that are live
-- ─────────────────────────────────────────────────────────────────────────
-- Union law (P2-1): a union's games carry the union container as club_id, so
-- a club's tables are its own plus its union's. Same scope the client's
-- clubGamesOrFilter() builds for the raw select this replaces.
--
-- `live` is every table in a live status, fullest first, capped at 500 with
-- `live_truncated` saying so; `recent` is the newest 25 that are not live and
-- not deleted, so a table that just closed is still findable. A running table
-- flagged is_deleted stays in `live`: the engine keeps dealing on it.
CREATE OR REPLACE FUNCTION public.ca_club_tables(p_club_id uuid, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_union uuid;
  v_cap integer := least(greatest(coalesce(p_limit, 500), 1), 500);
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  WITH scoped AS (
    SELECT t.id, t.name, t.game_type, t.game_variant, t.stakes,
           t.small_blind, t.big_blind, t.status, t.max_players, t.created_at,
           coalesce(t.is_deleted, false) AS is_deleted,
           t.status IN ('running', 'waiting', 'active') AS is_live
    FROM tables t
    WHERE t.club_id = p_club_id
       OR (v_union IS NOT NULL AND t.union_id = v_union)
  ),
  seats AS (
    SELECT ts.table_id, count(*) AS seated
    FROM table_seats ts
    WHERE ts.left_at IS NULL
      AND ts.table_id IN (SELECT id FROM scoped WHERE is_live)
    GROUP BY ts.table_id
  ),
  live AS (
    SELECT s.*, coalesce(se.seated, 0)::integer AS current_players
    FROM scoped s
    LEFT JOIN seats se ON se.table_id = s.id
    WHERE s.is_live
    ORDER BY coalesce(se.seated, 0) DESC, s.created_at DESC
    LIMIT v_cap
  ),
  recent AS (
    SELECT s.*, 0 AS current_players
    FROM scoped s
    WHERE NOT s.is_live AND NOT s.is_deleted
    ORDER BY s.created_at DESC
    LIMIT 25
  )
  SELECT jsonb_build_object(
    'live', coalesce((SELECT jsonb_agg(to_jsonb(l) - 'is_live') FROM live l), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(to_jsonb(r) - 'is_live') FROM recent r), '[]'::jsonb),
    'live_count', (SELECT count(*) FROM scoped WHERE is_live),
    'live_truncated', (SELECT count(*) FROM scoped WHERE is_live) > v_cap,
    'total_count', (SELECT count(*) FROM scoped WHERE NOT is_deleted OR is_live),
    'seated_people', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts
      WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
        AND ts.table_id IN (SELECT id FROM scoped WHERE is_live)
    ),
    'seat_rows', (
      SELECT count(*) FROM table_seats ts
      WHERE ts.left_at IS NULL
        AND ts.table_id IN (SELECT id FROM scoped WHERE is_live)
    )
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_tables(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_tables(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_tables(uuid, integer) IS
  'Club dashboard Tables tab: every live table (fullest first, seats counted from table_seats, capped at 500 and saying so) plus the 25 most recently closed. Membership-gated by ca_can_view_club. Horses are counted like every other player.';

-- ─────────────────────────────────────────────────────────────────────────
--  2. ca_club_dashboard_stats: seated_now counts people, and the day
--     window is read once
-- ─────────────────────────────────────────────────────────────────────────
-- Besides the seat count, this function was spending 132,855 buffers and
-- ~910 ms per call (EXPLAIN ANALYZE, 2026-09-04) and the reason is the
-- fallback. club_daily_stats is not a table: it is a view that re-aggregates
-- every rake_records row the club has ever written (163,585 for this club)
-- and sequentially scans rake_history (1.37M rows) with no date pushdown.
-- The old body referenced it FIVE times (today, today's rake, week, week's
-- rake, series), so the view ran five times per dashboard load: 39,406
-- buffers and ~250 ms each.
--
-- It was there for "dates predating the rollup". The rollup
-- (club_hand_daily_shard) begins 2026-07-22 and this function only ever
-- reads the last 14 days, so the fallback has had nothing to fall back to
-- since 2026-08-05 and cannot again. The 14-day window is now read once
-- from the rollup into a CTE and everything else is derived from it.
-- ca_club_revenue, which reads windows up to 90 days, already reads the
-- rollup alone.
CREATE OR REPLACE FUNCTION public.ca_club_dashboard_stats(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH days AS (
    -- club_hand_daily is exact: the engine maintains it per hand.
    SELECT g.day::date AS d,
           coalesce(h.hands, 0)::bigint AS hands,
           coalesce(h.rake, 0)::numeric AS rake
    FROM generate_series(v_today - 13, v_today, interval '1 day') g(day)
    LEFT JOIN club_hand_daily h ON h.club_id = p_club_id AND h.stat_date = g.day::date
  )
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
    'hands_today', (SELECT hands FROM days WHERE d = v_today),
    'rake_today',  (SELECT rake  FROM days WHERE d = v_today),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', (SELECT sum(hands) FROM days WHERE d >= v_today - 6),
    'rake_week',  (SELECT sum(rake)  FROM days WHERE d >= v_today - 6),
    -- PEOPLE, not seat rows. A player at two tables is one person seated.
    -- Measured 2026-09-04: 479 seat rows for 243 people at this club.
    'seated_now', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
    ),
    'daily_series', (
      SELECT jsonb_agg(jsonb_build_object('d', d, 'hands', hands, 'rake', rake) ORDER BY d)
      FROM days
    )
  ) INTO v;

  RETURN v;
END;
$function$;

COMMENT ON FUNCTION public.ca_club_dashboard_stats(uuid) IS
  'Club dashboard metric cards and 14-day series, read from the per-hand rollup in one pass. seated_now counts distinct people since 2026-09-04 (it counted seat rows before). Membership-gated by ca_can_view_club.';

-- ─────────────────────────────────────────────────────────────────────────
--  3. ca_club_top_players: the server orders by the key the viewer chose
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.ca_club_top_players(uuid, timestamp with time zone, integer);

CREATE FUNCTION public.ca_club_top_players(
  p_club_id uuid,
  p_since timestamp with time zone DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_sort text DEFAULT 'profit'
)
RETURNS TABLE(
  user_id uuid, display_name text, avatar_url text, is_horse boolean,
  hands_played bigint, hands_attributed bigint, hands_won bigint,
  total_won numeric, profit numeric, biggest_pot_won numeric, win_rate numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_may_see boolean := public.fn_can_see_horse_flag(p_club_id);
  v_sort text := lower(coalesce(p_sort, 'profit'));
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF v_sort NOT IN ('profit', 'hands', 'winrate', 'biggest') THEN
    v_sort := 'profit';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      s.user_id,
      public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                           pr.first_name, pr.last_name, pr.full_name) AS display_name,
      pr.avatar_url,
      (v_may_see AND coalesce(pr.is_horse, false)) AS is_horse,
      sum(s.hands_played)::bigint              AS hands_played,
      sum(s.hands_attributed)::bigint          AS hands_attributed,
      sum(s.hands_won)::bigint                 AS hands_won,
      sum(s.total_won)                         AS total_won,
      sum(s.profit)                            AS profit,
      max(s.biggest_pot_won)                   AS biggest_pot_won,
      round(100.0 * sum(s.hands_won) / nullif(sum(s.hands_played), 0), 1) AS win_rate
    FROM club_member_daily_stats s
    LEFT JOIN profiles pr ON pr.id = s.user_id
    WHERE s.club_id = p_club_id
      AND (p_since IS NULL OR s.stat_date >= (p_since AT TIME ZONE 'UTC')::date)
    GROUP BY s.user_id, pr.alias, pr.username, pr.display_name,
             pr.first_name, pr.last_name, pr.full_name, pr.avatar_url, pr.is_horse
    HAVING sum(s.hands_played) > 0
  )
  SELECT a.user_id, a.display_name, a.avatar_url, a.is_horse,
         a.hands_played, a.hands_attributed, a.hands_won,
         a.total_won, a.profit, a.biggest_pot_won, a.win_rate
  FROM agg a
  ORDER BY
    CASE WHEN v_sort = 'hands'   THEN a.hands_played    END DESC NULLS LAST,
    CASE WHEN v_sort = 'winrate' THEN a.win_rate        END DESC NULLS LAST,
    CASE WHEN v_sort = 'biggest' THEN a.biggest_pot_won END DESC NULLS LAST,
    a.profit DESC,
    a.user_id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamp with time zone, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamp with time zone, integer, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_top_players(uuid, timestamp with time zone, integer, text) IS
  'Club dashboard leaderboard. p_sort (profit | hands | winrate | biggest) orders BEFORE the limit, so the top N shown under a key is the top N by that key. Membership-gated by ca_can_view_club; the horse flag is masked by fn_can_see_horse_flag.';

-- ─────────────────────────────────────────────────────────────────────────
--  4. ca_club_tournaments: the limit limits, the window is the viewer's
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.ca_club_tournaments(uuid, integer);

CREATE FUNCTION public.ca_club_tournaments(
  p_club_id uuid,
  p_limit integer DEFAULT 20,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_union uuid;
  v_cap integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  WITH scoped AS (
    SELECT t.*
    FROM tournaments t
    WHERE t.club_id = p_club_id
       OR (v_union IS NOT NULL AND t.union_id = v_union)
  ),
  live AS (
    SELECT t.id, t.name, t.status,
           coalesce(t.variant, t.game_type) AS variant,
           coalesce(t.buy_in_amount, 0) AS buy_in,
           coalesce(t.prize_pool, 0) AS prize_pool,
           coalesce(t.current_players, 0) AS players,
           t.max_players, t.start_time
    FROM scoped t
    WHERE t.status IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')
    ORDER BY t.start_time
    LIMIT v_cap
  ),
  recent AS (
    SELECT t.id, t.name, t.status,
           coalesce(t.variant, t.game_type) AS variant,
           coalesce(t.buy_in_amount, 0) AS buy_in,
           coalesce(t.prize_pool, 0) AS prize_pool,
           coalesce(t.current_players, 0) AS players,
           t.ended_at
    FROM scoped t
    WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from
    ORDER BY t.ended_at DESC
    LIMIT v_cap
  )
  SELECT jsonb_build_object(
    'live', coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.start_time) FROM live l), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.ended_at DESC) FROM recent r), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'window_days', v_days,
        'live_count', count(*) FILTER (WHERE t.status IN ('running','registering','late_reg','starting','scheduled')),
        'completed_in_window', count(*) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from),
        'prize_pool_in_window', coalesce(sum(t.prize_pool) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from), 0),
        -- LEGACY, one release. The bundle serving while this migration is
        -- applied reads completed_30d / prize_pool_30d and calls without
        -- p_days, so for that caller the window IS 30 days and these are
        -- exact. Remove once the phase 4 client has published.
        'completed_30d', count(*) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from),
        'prize_pool_30d', coalesce(sum(t.prize_pool) FILTER (WHERE t.ended_at IS NOT NULL AND t.ended_at > v_from), 0)
      )
      FROM scoped t
    )
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_tournaments(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_tournaments(uuid, integer, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_club_tournaments(uuid, integer, integer) IS
  'Club dashboard Tournaments tab: live and upcoming, plus those finished inside p_days, each capped at p_limit BEFORE aggregation. Summary counts are over the whole window and say how long it is. Membership-gated by ca_can_view_club.';

-- ─────────────────────────────────────────────────────────────────────────
--  5. ca_club_revenue: a finance read is gated like the other finance reads
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_club_revenue(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
  v_union uuid;
BEGIN
  -- Rake, bad beat drop and insurance net are the club's money, not club
  -- news. ca_can_view_club admits any non-banned member; this is the gate the
  -- insurance report and club data already use.
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT union_id INTO v_union FROM clubs WHERE id = p_club_id;

  SELECT jsonb_build_object(
    'range_days', greatest(least(coalesce(p_days,14), 90), 1),
    'totals', (
      SELECT jsonb_build_object(
        'hands', coalesce(sum(d.hands), 0),
        'rake',  coalesce(sum(d.rake), 0),
        'bbj',   coalesce(sum(d.bbj), 0),
        'pot_total', coalesce(sum(d.pot_total), 0),
        'avg_pot', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.pot_total) / sum(d.hands), 4) ELSE 0 END,
        'rake_per_hand', CASE WHEN coalesce(sum(d.hands),0) > 0
                        THEN round(sum(d.rake) / sum(d.hands), 4) ELSE 0 END
      )
      FROM club_hand_daily d
      WHERE d.club_id = p_club_id AND d.stat_date >= v_from
    ),
    'insurance', (
      SELECT jsonb_build_object(
        'contracts', coalesce(count(*), 0),
        'premiums',  round(coalesce(sum(it.premium), 0), 2),
        'payouts',   round(coalesce(sum(it.payout), 0), 2),
        'net',       round(coalesce(sum(it.premium - it.payout), 0), 2),
        'bank',      CASE WHEN v_union IS NULL THEN 'club' ELSE 'union' END)
      FROM insurance_transactions it
      WHERE it.club_id = p_club_id
        AND it.created_at >= v_from::timestamptz
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, 0),
               'rake', coalesce(d.rake, 0),
               'bbj', coalesce(d.bbj, 0),
               'pot_total', coalesce(d.pot_total, 0),
               'ins_net', coalesce(i.net, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
      LEFT JOIN (
        SELECT (it.created_at AT TIME ZONE 'UTC')::date AS d,
               round(sum(it.premium - it.payout), 2) AS net
          FROM insurance_transactions it
         WHERE it.club_id = p_club_id AND it.created_at >= v_from::timestamptz
         GROUP BY 1
      ) i ON i.d = g.day::date
    ), '[]'::jsonb),
    'by_table', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'hands')::bigint DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', s.table_id,
                 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes,
                            concat(t.small_blind::text, '/', t.big_blind::text)),
                 'hands', sum(s.hands_played),
                 'players', count(DISTINCT s.user_id)
               ) AS x
        FROM club_member_daily_stats s
        LEFT JOIN tables t ON t.id = s.table_id
        WHERE s.club_id = p_club_id AND s.stat_date >= v_from
        GROUP BY s.table_id, t.name, t.status, t.stakes, t.small_blind, t.big_blind
        ORDER BY sum(s.hands_played) DESC
        LIMIT 20
      ) q
    ), '[]'::jsonb)
  ) INTO v;

  RETURN v;
END;
$function$;

COMMENT ON FUNCTION public.ca_club_revenue(uuid, integer) IS
  'Club dashboard Revenue tab over the last p_days (1..90) days. Finance-gated by ca_can_view_club_finances since 2026-09-04; before that any member could read it.';

-- ─────────────────────────────────────────────────────────────────────────
--  Assertions: the board is the shape this migration assumed
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'ca_club_top_players';
  IF n <> 1 THEN RAISE EXCEPTION 'ca_club_top_players has % overloads, expected 1', n; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'ca_club_tournaments';
  IF n <> 1 THEN RAISE EXCEPTION 'ca_club_tournaments has % overloads, expected 1', n; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('ca_club_tables', 'ca_club_dashboard_stats', 'ca_club_top_players',
                       'ca_club_tournaments', 'ca_club_revenue')
     AND p.prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 definer functions granted to authenticated and not anon, found %', n; END IF;
END $$;

COMMIT;
