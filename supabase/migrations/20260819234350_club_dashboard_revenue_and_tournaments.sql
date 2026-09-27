-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819234350 "club_dashboard_revenue_and_tournaments"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 25981df0b539108494eef680c0d11201 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Two gaps the dashboard never covered.
--
-- 1. REVENUE. club_hand_daily already stores rake, bbj and pot_total per club
--    per day, and nothing displayed any of it. Owners had no view of what the
--    club actually earns, by day or by table.
-- 2. TOURNAMENTS. The dashboard was cash-only: MTT/SNG activity did not appear
--    anywhere, so a club running tournaments looked idle between cash hands.
--
-- Both are membership-gated exactly like the other dashboard RPCs.

CREATE OR REPLACE FUNCTION public.ca_club_revenue(
  p_club_id uuid,
  p_days    integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v jsonb;
  v_from date := (now() AT TIME ZONE 'UTC')::date - (greatest(least(coalesce(p_days,14), 90), 1) - 1);
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

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
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date,
               'hands', coalesce(d.hands, 0),
               'rake', coalesce(d.rake, 0),
               'bbj', coalesce(d.bbj, 0),
               'pot_total', coalesce(d.pot_total, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
    ), '[]'::jsonb),
    -- Per-table contribution over the window, from the per-table player rows.
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
$fn$;

CREATE OR REPLACE FUNCTION public.ca_club_tournaments(
  p_club_id uuid,
  p_limit   integer DEFAULT 20
)
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
    'live', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'status', t.status,
               'variant', coalesce(t.variant, t.game_type),
               'buy_in', coalesce(t.buy_in_amount, 0),
               'prize_pool', coalesce(t.prize_pool, 0),
               'players', coalesce(t.current_players, 0),
               'max_players', t.max_players,
               'start_time', t.start_time)
             ORDER BY t.start_time)
      FROM tournaments t
      WHERE t.club_id = p_club_id
        AND t.status IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')
      LIMIT least(greatest(coalesce(p_limit,20),1), 50)
    ), '[]'::jsonb),
    'recent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'status', t.status,
               'variant', coalesce(t.variant, t.game_type),
               'buy_in', coalesce(t.buy_in_amount, 0),
               'prize_pool', coalesce(t.prize_pool, 0),
               'players', coalesce(t.current_players, 0),
               'ended_at', t.ended_at)
             ORDER BY t.ended_at DESC)
      FROM tournaments t
      WHERE t.club_id = p_club_id
        AND t.ended_at IS NOT NULL
        AND t.ended_at > now() - interval '30 days'
      LIMIT least(greatest(coalesce(p_limit,20),1), 50)
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'live_count', count(*) FILTER (WHERE t.status IN ('running','registering','late_reg','starting','scheduled')),
        'completed_30d', count(*) FILTER (WHERE t.ended_at > now() - interval '30 days'),
        'prize_pool_30d', coalesce(sum(t.prize_pool) FILTER (WHERE t.ended_at > now() - interval '30 days'), 0)
      )
      FROM tournaments t WHERE t.club_id = p_club_id
    )
  ) INTO v;

  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_club_revenue(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ca_club_tournaments(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_revenue(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_club_tournaments(uuid, integer) TO authenticated, service_role;
