-- The two covering indexes remove most heap work, but the Players RPC still
-- read the same date window twice: once for cash and once for tournaments.
-- Shark Club can cross the 8 second role timeout when those two passes compete
-- with foreground writes. Aggregate both nets in one indexed wallet pass.

CREATE OR REPLACE FUNCTION public.ca_club_player_breakdown(
  p_club_id uuid,
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_end   date := LEAST(COALESCE(p_end, v_today), v_today);
  v_start date := COALESCE(p_start, v_end - 13);
  v_from  timestamptz;
  v_to    timestamptz;
  v_lim   int := GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1);
  v_union uuid;
  v_out   jsonb;
BEGIN
  IF NOT ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  IF v_start < v_end - 92 THEN v_start := v_end - 92; END IF;
  IF v_start > v_end THEN v_start := v_end; END IF;
  v_from := (v_start::timestamp AT TIME ZONE 'UTC');
  v_to := ((v_end + 1)::timestamp AT TIME ZONE 'UTC');

  SELECT uc.union_id INTO v_union
    FROM union_clubs uc
   WHERE uc.club_id = p_club_id
   LIMIT 1;

  WITH att_club AS MATERIALIZED (
    SELECT a.user_id
      FROM (
        SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
          FROM club_members cm
          JOIN union_clubs uc
            ON uc.club_id = cm.club_id
           AND uc.union_id = v_union
         WHERE v_union IS NOT NULL
         ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
      ) a
     WHERE a.club_id = p_club_id
    UNION
    SELECT cm.user_id
      FROM club_members cm
     WHERE v_union IS NULL
       AND cm.club_id = p_club_id
  ),
  union_tables AS MATERIALIZED (
    SELECT id
      FROM tables
     WHERE union_id = v_union
       AND tournament_id IS NULL
  ),
  wallet_pnl AS (
    SELECT wt.user_id,
           SUM(
             CASE
               WHEN wt.category IN ('buyin', 'cashout') AND ut.id IS NOT NULL
                 THEN CASE
                        WHEN wt.type = 'credit' THEN wt.amount
                        WHEN wt.type = 'debit' THEN -wt.amount
                        ELSE 0
                      END
               ELSE 0
             END
           ) AS cash_net,
           SUM(
             CASE
               WHEN wt.category = 'tournament_buyin'
                 AND wt.related_entity_id IS NOT NULL THEN -wt.amount
               WHEN wt.category IN ('prize', 'bounty')
                 AND wt.related_entity_id IS NOT NULL THEN wt.amount
               ELSE 0
             END
           ) AS tournament_net
      FROM wallet_transactions wt
      JOIN att_club a ON a.user_id = wt.user_id
      LEFT JOIN union_tables ut ON ut.id = wt.table_id
     WHERE wt.created_at >= v_from
       AND wt.created_at < v_to
       AND (
         (wt.category IN ('buyin', 'cashout') AND wt.table_id IS NOT NULL)
         OR (
           wt.category IN ('tournament_buyin', 'prize', 'bounty')
           AND wt.related_entity_id IS NOT NULL
         )
       )
     GROUP BY wt.user_id
  ),
  rake AS (
    SELECT u.user_id, SUM(u.rake_amount) AS rake
      FROM union_rake_paid_daily_user u
      JOIN att_club a ON a.user_id = u.user_id
     WHERE u.union_id = v_union
       AND u.day BETWEEN v_start AND v_end
     GROUP BY u.user_id
  ),
  hands AS (
    SELECT s.user_id, SUM(s.hands_played)::bigint AS hands
      FROM club_member_daily_stats s
      JOIN att_club a ON a.user_id = s.user_id
     WHERE s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
  ),
  merged AS MATERIALIZED (
    SELECT a.user_id,
           round(COALESCE(w.cash_net, 0), 2) AS cash_net,
           round(COALESCE(w.tournament_net, 0), 2) AS tournament_net,
           round(COALESCE(w.cash_net, 0) + COALESCE(w.tournament_net, 0), 2) AS net,
           round(COALESCE(r.rake, 0), 2) AS rake,
           COALESCE(h.hands, 0) AS hands
      FROM att_club a
      LEFT JOIN wallet_pnl w ON w.user_id = a.user_id
      LEFT JOIN rake r ON r.user_id = a.user_id
      LEFT JOIN hands h ON h.user_id = a.user_id
     WHERE COALESCE(w.cash_net, 0) <> 0
        OR COALESCE(w.tournament_net, 0) <> 0
        OR COALESCE(r.rake, 0) <> 0
        OR COALESCE(h.hands, 0) <> 0
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'start', v_start,
      'end', v_end,
      'days', (v_end - v_start) + 1
    ),
    'rake_complete_through', LEAST(v_end, v_today - 1),
    'totals', (
      SELECT jsonb_build_object(
        'players', count(*),
        'net', round(COALESCE(SUM(m.net), 0), 2),
        'rake', round(COALESCE(SUM(m.rake), 0), 2),
        'hands', COALESCE(SUM(m.hands), 0)
      )
        FROM merged m
    ),
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', q.user_id,
               'username', COALESCE(pr.display_name, pr.username, 'Player'),
               'avatar_url', pr.avatar_url,
               'is_horse', COALESCE(pr.is_horse, false),
               'net', q.net,
               'cash_net', q.cash_net,
               'tournament_net', q.tournament_net,
               'rake', q.rake,
               'hands', q.hands
             ) ORDER BY q.net DESC)
        FROM (
          SELECT *
            FROM merged
           ORDER BY net DESC
           LIMIT v_lim
        ) q
        LEFT JOIN profiles pr ON pr.id = q.user_id
    ), '[]'::jsonb),
    'player_count', (SELECT count(*) FROM merged),
    'generated_at', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_player_breakdown(uuid, date, date, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_player_breakdown(uuid, date, date, integer)
  TO authenticated, service_role;
