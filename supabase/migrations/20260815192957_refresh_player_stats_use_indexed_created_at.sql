-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815192957 "refresh_player_stats_use_indexed_created_at"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3863d376d4836fac4d62032f577285b3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- hand_history is 5.7M rows / 9.8 GB. The first version filtered on ended_at,
-- which has no index, so every call full-scanned the table and timed out.
-- created_at is indexed (idx_hand_history_created, DESC) and is written at the
-- same moment (rows are only inserted at hand completion), so switch to it.

CREATE OR REPLACE FUNCTION public.fn_refresh_player_stats(
  p_since timestamptz DEFAULT now() - interval '7 days'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_users integer := 0; v_hands integer := 0;
BEGIN
  CREATE TEMP TABLE _ps ON COMMIT DROP AS
  WITH h AS (
    SELECT hh.id, hh.players, hh.actions, t.club_id
      FROM hand_history hh
      LEFT JOIN tables t ON t.id = hh.table_id
     WHERE hh.created_at >= p_since          -- indexed
       AND hh.players IS NOT NULL
       AND jsonb_typeof(hh.players) = 'array'
  ),
  seats AS (
    SELECT h.id AS hand_id, h.club_id,
           (p->>'seat')::int AS seat,
           (p->>'userId')::uuid AS user_id
      FROM h, jsonb_array_elements(h.players) p
     WHERE p->>'userId' IS NOT NULL AND p->>'seat' IS NOT NULL
  ),
  acts AS (
    SELECT h.id AS hand_id,
           (a->>'seat')::int AS seat,
           bool_or(a->>'action' IN ('call','raise','bet','all_in','allin')) AS vpip,
           bool_or(a->>'action' IN ('raise','bet','all_in','allin')) AS pfr
      FROM h, jsonb_array_elements(h.actions) a
     WHERE jsonb_typeof(h.actions) = 'array'
       AND lower(COALESCE(a->>'stage','')) = 'preflop'
       AND a->>'seat' IS NOT NULL
     GROUP BY 1, 2
  )
  SELECT s.user_id, s.club_id,
         count(*)::int AS hands,
         count(*) FILTER (WHERE COALESCE(ac.vpip,false))::int AS vpip_hands,
         count(*) FILTER (WHERE COALESCE(ac.pfr,false))::int  AS pfr_hands
    FROM seats s
    LEFT JOIN acts ac ON ac.hand_id = s.hand_id AND ac.seat = s.seat
   WHERE s.club_id IS NOT NULL
   GROUP BY s.user_id, s.club_id;

  SELECT count(*), COALESCE(sum(hands),0) INTO v_users, v_hands FROM _ps;

  INSERT INTO player_stats (user_id, club_id, hands_played, vpip, pfr, updated_at)
  SELECT user_id, club_id, hands,
         round((vpip_hands::numeric / NULLIF(hands,0)) * 100, 2),
         round((pfr_hands::numeric  / NULLIF(hands,0)) * 100, 2),
         now()
    FROM _ps
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET hands_played = GREATEST(COALESCE(player_stats.hands_played,0), EXCLUDED.hands_played),
         vpip = EXCLUDED.vpip,
         pfr  = EXCLUDED.pfr,
         updated_at = now();

  RETURN jsonb_build_object('users', v_users, 'hands_counted', v_hands, 'since', p_since);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_refresh_player_stats(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_refresh_player_stats(timestamptz) TO service_role;
