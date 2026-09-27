-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424001504 "20260421097000_bug21_update_player_stats_from_session_missing_cashout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8b744509cb2297e290a11b8f6ad41bf8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-21: update_player_stats_from_session trigger references
-- NEW.total_cashout, but commander_player_sessions has no such column
-- (only total_buyin and total_time_minutes). Every INSERT/UPDATE of a
-- completed session would 42703 → rollback.
--
-- Impact: venue check-in sessions with status='completed' silently
-- fail to update commander_player_stats aggregates. Player lifetime
-- stats on venue pages don't refresh.
--
-- Fix: Replace NEW.total_cashout with 0. If cashout tracking becomes
-- relevant later, that's a schema migration adding the column.

CREATE OR REPLACE FUNCTION public.update_player_stats_from_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  session_hours DECIMAL(6,2);
BEGIN
  IF NEW.status != 'completed' OR NEW.total_time_minutes IS NULL THEN
    RETURN NEW;
  END IF;
  session_hours := NEW.total_time_minutes / 60.0;
  INSERT INTO commander_player_stats (
    venue_id, player_id, first_visit, last_visit, total_visits,
    total_hours, total_buyin, total_cashout
  )
  VALUES (
    NEW.venue_id, NEW.player_id, CURRENT_DATE, CURRENT_DATE, 1, session_hours,
    COALESCE(NEW.total_buyin, 0),
    0  -- BUG-21 fix: commander_player_sessions has no total_cashout column
  )
  ON CONFLICT (venue_id, player_id) DO UPDATE SET
    last_visit   = CURRENT_DATE,
    total_visits = commander_player_stats.total_visits + 1,
    total_hours  = commander_player_stats.total_hours + session_hours,
    total_buyin  = commander_player_stats.total_buyin + COALESCE(NEW.total_buyin, 0),
    -- total_cashout stays at its accumulated value (no session delta)
    avg_session_hours     = (commander_player_stats.total_hours + session_hours)
                            / (commander_player_stats.total_visits + 1),
    longest_session_hours = GREATEST(commander_player_stats.longest_session_hours, session_hours),
    updated_at            = now();
  RETURN NEW;
END;
$function$;
