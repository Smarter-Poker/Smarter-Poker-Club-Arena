-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815192707 "player_stats_writers_for_leaderboards_and_leak_detection"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 999bea4dfea4c971146b9f34402b3691 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- VISIBLE FIX 2026-08-15 — two dead metrics pipelines.
--
-- (A) LEADERBOARDS: finishTournament writes standings, prizes, wallets and
--     rake, but never touches player_stats. The only incrementer in the
--     codebase (AchievementTriggerService.onTournamentComplete) has ZERO
--     callers, so player_stats.tournaments_played / tournaments_won are 0 for
--     every account ever (verified: 0 of 1,156 rows). Any "Tournaments Won"
--     board is therefore an all-zero list. Fixed with a trigger so it fires
--     no matter which code path completes the tournament.
--
-- (B) LEAK DETECTION: the assistant's detector reads player_stats.vpip / pfr.
--     Nothing writes them from real play — LeaderboardService.updateHandStats
--     has no callers, and its RPC discards every stat argument. 1,029 of 1,156
--     accounts sit at vpip = 0, including grinders with tens of thousands of
--     hands, so every pattern is skipped as "unmeasured" and the assistant
--     reports no leaks, forever. hand_history DOES carry what's needed:
--     actions[] has {seat, stage, action} and players[] maps seat -> userId,
--     for cash AND tournament hands alike.

-- ── (A) tournament counters ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_tournament_completed_stats()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status <> 'COMPLETED' OR COALESCE(OLD.status,'') = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
  SELECT tp.user_id,
         NEW.club_id,
         1,
         CASE WHEN tp.position = 1 OR tp.status = 'winner' THEN 1 ELSE 0 END,
         now()
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.user_id IS NOT NULL
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET tournaments_played = COALESCE(player_stats.tournaments_played,0)
                            + EXCLUDED.tournaments_played,
         tournaments_won    = COALESCE(player_stats.tournaments_won,0)
                            + EXCLUDED.tournaments_won,
         updated_at = now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_completed_stats ON public.tournaments;
CREATE TRIGGER tournament_completed_stats
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_completed_stats();

-- ── (B) real VPIP / PFR from stored hands ──────────────────────────────────
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
     WHERE hh.ended_at >= p_since
       AND hh.players IS NOT NULL
       AND jsonb_typeof(hh.players) = 'array'
  ),
  seats AS (  -- seat -> user for every dealt-in player
    SELECT h.id AS hand_id, h.club_id,
           (p->>'seat')::int AS seat,
           (p->>'userId')::uuid AS user_id
      FROM h, jsonb_array_elements(h.players) p
     WHERE p->>'userId' IS NOT NULL AND p->>'seat' IS NOT NULL
  ),
  acts AS (   -- preflop voluntary money + raises, per seat per hand
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
  SELECT s.user_id,
         s.club_id,
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

-- ── Backfill tournament counters from history (one-off) ────────────────────
INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
SELECT tp.user_id, t.club_id,
       count(*)::int,
       count(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::int,
       now()
  FROM tournament_players tp
  JOIN tournaments t ON t.id = tp.tournament_id
 WHERE t.status = 'COMPLETED' AND tp.user_id IS NOT NULL AND t.club_id IS NOT NULL
 GROUP BY tp.user_id, t.club_id
ON CONFLICT (user_id, club_id) DO UPDATE
   SET tournaments_played = EXCLUDED.tournaments_played,
       tournaments_won    = EXCLUDED.tournaments_won,
       updated_at = now();
