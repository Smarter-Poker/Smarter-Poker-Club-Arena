-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823042610 "publish_schedule_card_24h_open_empty"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09242c5f9fabb07d3bd566dd887738da of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PUBLISH THE WHOLE CARD, AND OPEN IT EMPTY
-- 2026-08-23, Cowork session 11h
--
-- Dan: "tournaments are FAR FROM WORKING! WE DON'T EVEN HAVE ANY LISTED."
-- He is right. At 04:25 UTC the board carried TWO registering MTTs out of
-- thirty-eight active schedules: one 35 hours stale, one twelve hours out.
--
-- The engine is not broken and the schedules are not broken. Every schedule
-- fires on time, but the spawner only creates an instance 30 MINUTES before
-- its start, and a horse-filled field starts on the minute and plays out
-- fast. So the lobby is empty almost all of the time.
--
-- The code fix for this is written and waiting in a pull request, but the
-- SAME behaviour is reachable RIGHT NOW as pure data, because the deployed
-- spawner already honours two per-schedule config keys:
--
--   spawnAheadMinutes  (accepted range 30..10080) — how far ahead to publish.
--                      Proven live: the Sunday Major carries 10080 and has
--                      been sitting on the board for a week.
--   horsesToRegister   — how many horses to seed AT SPAWN. Zero means the
--                      event opens EMPTY.
--
-- Both are set here: a full day of look-ahead so tomorrow's card is on the
-- board tonight, and zero seeding so a horse is never locked into an event
-- that has not started. GameServer's past-start top-up still fills any short
-- field on the clock, which is the mechanism that already rescues every
-- short field today — so the games still run full, they just stop being
-- invisible and stop being pre-filled.
--
-- The Sunday Major keeps its week (10080 > 1440); it is the flagship and its
-- satellites resolve it by name all week.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.tournament_schedules
   SET config = config
                || jsonb_build_object(
                     'spawnAheadMinutes',
                     GREATEST(COALESCE((config->>'spawnAheadMinutes')::int, 0), 1440),
                     'horsesToRegister', 0),
       updated_at = now()
 WHERE active;

-- POST-APPLY ASSERTIONS ─────────────────────────────────────────────────────
DO $$
DECLARE v_bad integer; v_major integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.tournament_schedules
   WHERE active
     AND (COALESCE((config->>'spawnAheadMinutes')::int, 0) < 1440
          OR COALESCE((config->>'horsesToRegister')::int, -1) <> 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% active schedule(s) did not take the new publish settings', v_bad;
  END IF;

  -- The flagship must not have been demoted from its week.
  SELECT COALESCE((config->>'spawnAheadMinutes')::int, 0) INTO v_major
    FROM public.tournament_schedules WHERE name = 'Sunday Midway Major' AND active;
  IF v_major IS NOT NULL AND v_major < 10080 THEN
    RAISE EXCEPTION 'Sunday Major look-ahead was reduced to %', v_major;
  END IF;

  -- Every schedule must still carry a usable type, or the spawner skips it.
  SELECT count(*) INTO v_bad FROM public.tournament_schedules
   WHERE active AND COALESCE(config->>'type','') NOT IN
     ('mtt','freezeout','bounty','progressive_bounty','mystery_bounty','satellite','sng','spin');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% active schedule(s) carry an unknown type', v_bad;
  END IF;
END $$;
