-- ═══════════════════════════════════════════════════════════════════════════
--  HANDS PLAYED IS THE NUMBER YOU PLAYED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `profiles.total_hands_played` sums to SIX across the whole platform.
-- Measured 2026-09-05:
--
--     profiles                                 1,312 rows
--     profiles with total_hands_played > 0         1 row, holding 6
--     player_stats                             2,795 rows, 1,006 players
--     SUM(player_stats.hands_played)           6,764,566
--     busiest single player                       75,356
--
-- Nothing has written that column since it was added. It is not merely stale,
-- it has never been true.
--
-- WHAT READS IT, AND WHAT THEY SHOW BECAUSE OF IT
--
--   ProfileService.mapProfile  -> `handsPlayed`, so every surface fed by
--                                 getProfile / getPublicProfile shows 0.
--   ProfileService.getLeaderboard('hands') -> ORDER BY total_hands_played.
--                                 A leaderboard ordered by a column that is 0
--                                 for 1,311 of 1,312 rows is ordering by
--                                 nothing: it returns whatever Postgres feels
--                                 like, presented as a ranking.
--
-- WHY THE COLUMN AND NOT THE READERS
--
-- `player_stats` is the truth and it is keyed `(user_id, club_id)` - a player
-- has one row per club, which is what the achievement engine was fixed for on
-- 2026-09-05. Summing it per player is correct but it cannot be ORDER BY'd
-- through PostgREST from another table, so the leaderboard would still have
-- nothing to sort on.
--
-- So the column becomes a maintained rollup: backfilled once here, and kept
-- current by a trigger on the table that owns the truth. A rollup that is
-- written by a trigger cannot drift the way one written by a forgotten call
-- site does - which is exactly how it got to 6.
--
-- One transaction, per the production DDL policy (CLAUDE.md section 2).

BEGIN;

-- ── 1. The rollup, maintained where the truth changes ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_profile_total_hands()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF v_user IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  /* Recomputed from the table rather than incremented. An increment has to be
     right on every path - insert, update, delete, and the upsert the
     achievement engine uses - and being wrong once is permanent. A SUM over a
     handful of club rows for one player is cheap and cannot drift. */
  UPDATE public.profiles p
     SET total_hands_played = COALESCE((
           SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id = v_user
         ), 0)
   WHERE p.id = v_user;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.fn_sync_profile_total_hands() IS
  'Keeps profiles.total_hands_played equal to SUM(player_stats.hands_played) '
  'for that player. Recomputes rather than increments: an increment must be '
  'correct on every path and is permanent when it is not.';

DROP TRIGGER IF EXISTS trg_sync_profile_total_hands ON public.player_stats;
CREATE TRIGGER trg_sync_profile_total_hands
  AFTER INSERT OR UPDATE OF hands_played OR DELETE ON public.player_stats
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_profile_total_hands();

-- ── 2. The backfill ────────────────────────────────────────────────────────
UPDATE public.profiles p
   SET total_hands_played = COALESCE(s.total, 0)
  FROM (
    SELECT user_id, sum(hands_played) AS total
      FROM public.player_stats
     GROUP BY user_id
  ) s
 WHERE p.id = s.user_id
   AND p.total_hands_played IS DISTINCT FROM COALESCE(s.total, 0);

COMMENT ON COLUMN public.profiles.total_hands_played IS
  'Maintained rollup of SUM(player_stats.hands_played) for this player, kept '
  'current by trg_sync_profile_total_hands. Held 6 across the entire platform '
  'until 2026-09-05 because nothing ever wrote it, which made every profile '
  'read 0 hands and made the hands leaderboard an ORDER BY on a constant. '
  'player_stats, keyed (user_id, club_id), remains the source of truth.';

-- ── 3. Prove it, in the same transaction that did it ───────────────────────
DO $verify$
DECLARE
  v_wrong bigint;
  v_total bigint;
BEGIN
  SELECT count(*) INTO v_wrong
    FROM public.profiles p
    LEFT JOIN (
      SELECT user_id, sum(hands_played) AS total FROM public.player_stats GROUP BY user_id
    ) s ON s.user_id = p.id
   WHERE COALESCE(p.total_hands_played, 0) <> COALESCE(s.total, 0);

  SELECT COALESCE(sum(total_hands_played), 0) INTO v_total FROM public.profiles;

  IF v_wrong <> 0 THEN
    RAISE EXCEPTION 'ABORTING: % profile(s) still disagree with player_stats after the backfill', v_wrong;
  END IF;

  RAISE NOTICE 'total_hands_played now sums to % across every profile', v_total;
END;
$verify$;

COMMIT;
