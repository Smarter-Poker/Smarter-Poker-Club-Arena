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
    SELECT g.day::date AS d,
           coalesce(h.hands, 0)::bigint AS hands,
           coalesce(r.rake, 0)::numeric AS rake,
           coalesce(r.hands, 0)::bigint AS raked_hands,
           coalesce(m.fee, 0)::numeric AS tournament_fees
    FROM generate_series(v_today - 13, v_today, interval '1 day') g(day)
    LEFT JOIN club_hand_daily h ON h.club_id = p_club_id AND h.stat_date = g.day::date
    LEFT JOIN ca_club_rake_daily r ON r.club_id = p_club_id AND r.stat_date = g.day::date
    LEFT JOIN (
      SELECT t.stat_date, sum(t.fee) AS fee FROM ca_club_tournament_daily t
       WHERE t.club_id = p_club_id AND t.stat_date >= v_today - 13
       GROUP BY t.stat_date
    ) m ON m.stat_date = g.day::date
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
          AND EXISTS (SELECT 1 FROM public.profiles pp WHERE pp.id = cm.user_id AND coalesce(pp.is_online, false) AND pp.last_seen > now() - interval '5 minutes')
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
    'raked_hands_today', (SELECT raked_hands FROM days WHERE d = v_today),
    'rake_today',  (SELECT rake  FROM days WHERE d = v_today),
    'tournament_fees_today', (SELECT tournament_fees FROM days WHERE d = v_today),
    'new_this_week', (
      SELECT count(*) FROM club_members cm
      WHERE cm.club_id = p_club_id AND cm.created_at > now() - interval '7 days'
    ),
    'hands_week', (SELECT sum(hands) FROM days WHERE d >= v_today - 6),
    'raked_hands_week', (SELECT sum(raked_hands) FROM days WHERE d >= v_today - 6),
    'rake_week',  (SELECT sum(rake)  FROM days WHERE d >= v_today - 6),
    'tournament_fees_week', (SELECT sum(tournament_fees) FROM days WHERE d >= v_today - 6),
    -- PEOPLE, not seat rows. A player at two tables is one person seated.
    -- Measured 2026-09-04: 479 seat rows for 243 people at this club.
    'seated_now', (
      SELECT count(DISTINCT ts.user_id)
      FROM table_seats ts JOIN tables t ON t.id = ts.table_id
      WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
    ),
    'daily_series', (
      SELECT jsonb_agg(jsonb_build_object('d', d, 'hands', hands, 'rake', rake,
                                          'raked_hands', raked_hands,
                                          'tournament_fees', tournament_fees) ORDER BY d)
      FROM days
    ),
    'rake_source', 'rake_records'
  ) INTO v;

  RETURN v;
END;
$function$
;
