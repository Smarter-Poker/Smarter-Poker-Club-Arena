-- ============================================================================
-- 20260819k_club_dashboard_revenue_tournaments.sql
-- Club Dashboard — revenue view and tournament coverage (Tier 2, additive)
--
-- Applied to production as: club_dashboard_revenue_and_tournaments
--
-- Two gaps the dashboard never covered:
--
--  1. REVENUE. club_hand_daily already stores rake, bbj and pot_total per club
--     per day and nothing displayed any of it — owners had no view of what the
--     club actually earns. ca_club_revenue returns totals (rake, bbj, hands,
--     average pot, rake per hand), a daily series for charting, and the
--     busiest tables over the window.
--
--  2. TOURNAMENTS. The dashboard was cash-only, so a club running tournaments
--     looked idle between cash hands. Midway Union alone had 114 tournaments
--     finish in the last 30 days that appeared nowhere. ca_club_tournaments
--     returns live/upcoming, recently finished, and a 30-day summary.
--
-- Both are membership-gated via ca_can_view_club exactly like the other
-- dashboard RPCs, and neither grants anon.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ca_club_revenue(uuid, integer);
--   DROP FUNCTION IF EXISTS public.ca_club_tournaments(uuid, integer);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ca_club_revenue(p_club_id uuid, p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
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
                        THEN round(sum(d.rake) / sum(d.hands), 4) ELSE 0 END)
      FROM club_hand_daily d
      WHERE d.club_id = p_club_id AND d.stat_date >= v_from
    ),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', g.day::date, 'hands', coalesce(d.hands, 0), 'rake', coalesce(d.rake, 0),
               'bbj', coalesce(d.bbj, 0), 'pot_total', coalesce(d.pot_total, 0))
             ORDER BY g.day)
      FROM generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day') g(day)
      LEFT JOIN club_hand_daily d ON d.club_id = p_club_id AND d.stat_date = g.day::date
    ), '[]'::jsonb),
    'by_table', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'hands')::bigint DESC)
      FROM (
        SELECT jsonb_build_object(
                 'table_id', s.table_id, 'name', coalesce(t.name, 'Unnamed'),
                 'status', coalesce(t.status, 'unknown'),
                 'stakes', coalesce(t.stakes, concat(t.small_blind::text, '/', t.big_blind::text)),
                 'hands', sum(s.hands_played), 'players', count(DISTINCT s.user_id)) AS x
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

CREATE OR REPLACE FUNCTION public.ca_club_tournaments(p_club_id uuid, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v jsonb;
BEGIN
  IF NOT ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'live', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'status', t.status,
               'variant', coalesce(t.variant, t.game_type),
               'buy_in', coalesce(t.buy_in_amount, 0), 'prize_pool', coalesce(t.prize_pool, 0),
               'players', coalesce(t.current_players, 0), 'max_players', t.max_players,
               'start_time', t.start_time) ORDER BY t.start_time)
      FROM tournaments t
      WHERE t.club_id = p_club_id
        AND t.status IN ('running','registering','late_reg','starting','scheduled')
      LIMIT least(greatest(coalesce(p_limit,20),1), 50)
    ), '[]'::jsonb),
    'recent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'status', t.status,
               'variant', coalesce(t.variant, t.game_type),
               'buy_in', coalesce(t.buy_in_amount, 0), 'prize_pool', coalesce(t.prize_pool, 0),
               'players', coalesce(t.current_players, 0), 'ended_at', t.ended_at)
             ORDER BY t.ended_at DESC)
      FROM tournaments t
      WHERE t.club_id = p_club_id AND t.ended_at IS NOT NULL
        AND t.ended_at > now() - interval '30 days'
      LIMIT least(greatest(coalesce(p_limit,20),1), 50)
    ), '[]'::jsonb),
    'summary', (
      SELECT jsonb_build_object(
        'live_count', count(*) FILTER (WHERE t.status IN ('running','registering','late_reg','starting','scheduled')),
        'completed_30d', count(*) FILTER (WHERE t.ended_at > now() - interval '30 days'),
        'prize_pool_30d', coalesce(sum(t.prize_pool) FILTER (WHERE t.ended_at > now() - interval '30 days'), 0))
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
