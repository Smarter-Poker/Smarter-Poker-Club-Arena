-- ═══════════════════════════════════════════════════════════════════════════
--  A SPIN HAS NO SCHEDULED TIME (Dan, 2026-09-01, BINDING)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "SPINS AND HEADS UP DO NOT HAVE SCHEDULED TIMES THEY START
-- WHEN 3 PLAYERS HAVE BOUGHT IN AND PAID FOR SPINS, AND WHEN TWO PLAYERS FOR
-- HEADS UP."
--
-- One schedule row on this platform disagreed. "Spin Royale", seeded by
-- 20260822110000_midway_weekly_schedule_seed.sql, active, every 30 minutes, at
-- a 25-chip buy-in the Spin board does not offer -- SPIN_BOARD_BUYINS is
-- [1,2,3,5,10,20,50,100], so no human could reach this game from the board it
-- was not on.
--
-- WHAT IT ACTUALLY DID, measured before switching it off: 253 games between
-- 2026-08-22 and 2026-09-01, and exactly ONE human entry in ten days. Every
-- other seat was a horse. The mechanism is worth understanding, because it
-- looks like it worked: the schedule path never creates the open-seat table
-- that the seat-first start gate counts seats on, so the game could not fill
-- from the board; when its scheduled start_time passed, the past-start
-- top-up filled all three seats with horses, and the seat gate then saw three
-- paid seats and started it 20-40 seconds late. A clock-driven game that seats
-- itself and that no player can find.
--
-- The board creates Spins continuously and starts them on paid seats alone
-- (GameServer: `shouldStart = isSngOrSpin ? seatFirstReady : maxReached ||
-- timeReached`). There is nothing for a schedule to add, and the engine now
-- refuses to spawn one -- see ScheduledTournamentService.buildInsertRow. This
-- row is deactivated so it stops asking.
--
-- The 25-chip stake goes with it. It was never a board price point and the
-- club's reserve is seeded to a highest_stake of 100, so nothing is
-- under-funded by its absence. If a 25 rung is wanted it belongs in
-- SPIN_BOARD_BUYINS, where a player can see it.
--
-- ROLLBACK:
--   UPDATE public.tournament_schedules SET active = true
--    WHERE id = '1ac67586-c0df-4119-89de-6f34a88da536';
--   (and revert the engine guard, or the spawn will be refused anyway)

UPDATE public.tournament_schedules
   SET active = false
 WHERE id = '1ac67586-c0df-4119-89de-6f34a88da536'
   AND (config->>'type') = 'spin';

DO $$
DECLARE v_active integer;
BEGIN
  SELECT count(*) INTO v_active
  FROM public.tournament_schedules
  WHERE active
    AND ( (config->>'type') = 'spin'
          OR ( (config->>'type') = 'sng'
               AND COALESCE((config->>'maxPlayers')::int, 2) <= 2 ) );
  IF v_active <> 0 THEN
    RAISE EXCEPTION 'still % active schedule(s) asking for a seat-first format', v_active;
  END IF;
END $$;
