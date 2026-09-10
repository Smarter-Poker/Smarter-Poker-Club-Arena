-- a_manager_sweeps_itself_once_when_it_adopts_the_event
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- The one-time correction that ships WITH its cause fix (CLAUDE.md 10.9 / 10.12).
-- The cause is in the engine, in this same branch:
-- TournamentManagerBase.resumeLifecycle / startLifecycle now request one
-- elimination sweep after registering the scheduler.
--
-- WHY, read from rows and from the engine's own log:
--
-- Registering the elimination scheduler makes a manager WAKEABLE; it does not
-- ask for anything. The routine wake is `onHandComplete` with a zero stack.
-- So a manager that adopts an event whose tables cannot deal has no way to ask
-- for the sweep that would make them dealable - table balancing is stage 5 of
-- that very sweep, and consolidation is what turns 34 tables of one player
-- into a table with players on it.
--
-- Between 06:05 and 06:48 today fifteen tournaments lost and retook their
-- leases while the FOR SHARE / heartbeat conflict was being fixed
-- (20260910063559, 20260910064701). Every one resumed correctly - the engine
-- logged `Resumed - 34 tables, level 11` for 7f521f47 at 06:48:55 - and then
-- swept no more. At 07:42 that event held 34 tables, one live seat each, all
-- funded, the blind clock at level 21, its last hand at 07:21, and 249 busted
-- players sitting in `playing` with a pending knockout candidate that nothing
-- would ever read. Prime Time Free Buy had been that way for 97 minutes.
-- 33883f12: 23 tables, one seat each, no hand since 07:07. f922df63,
-- bee519fa, 89f67f79, 7aa16fa7 and nine more, the same.
--
-- The eliminations are not lost and no money is at stake in this file: the
-- knockout door accepts every one of them (probed and rolled back at 07:38 -
-- three players in 7f521f47 returned ok/claimed at places 401-403). They are
-- simply never asked for.
--
-- WHAT THIS DOES: emits one durable `late_registration` manager wake per
-- affected event through the platform's own emitter,
-- fn_emit_tournament_manager_wake - the same row a late registration writes,
-- delivered to the engine over Realtime and drained on reconnect. The manager
-- reconciles its entry window (a no-op for a completed receipt) and then runs
-- the sweep it has been unable to ask for. Nothing here repairs a roster row,
-- moves a chip or assigns a place; the engine does all of that through its own
-- doors, as it would have done at 06:48.
--
-- It is a correction, not a job: it runs once, it is not scheduled, and once
-- the engine change is deployed no event can arrive in this state again.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  r record;
  v_woken integer := 0;
  v_stalled integer := 0;
  v_id bigint;
BEGIN
  SELECT count(*) INTO v_stalled
    FROM public.tournaments t
   WHERE t.status = 'RUNNING'
     AND EXISTS (SELECT 1 FROM public.tournament_players tp
                  WHERE tp.tournament_id = t.id AND tp.status = 'playing'
                    AND COALESCE(tp.chips, 0) <= 0);
  IF v_stalled = 0 THEN
    RAISE EXCEPTION 'no RUNNING event is holding a busted player; there is nothing to wake and this migration is being applied against a board it does not describe';
  END IF;

  FOR r IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = t.id AND tp.status = 'playing'
                      AND COALESCE(tp.chips, 0) <= 0)
     ORDER BY t.id
  LOOP
    v_id := public.fn_emit_tournament_manager_wake(r.id, 'late_registration');
    IF v_id IS NOT NULL THEN v_woken := v_woken + 1; END IF;
  END LOOP;

  IF v_woken <> v_stalled THEN
    RAISE EXCEPTION 'woke % manager(s) of % holding busted players', v_woken, v_stalled;
  END IF;

  RAISE NOTICE 'a_manager_sweeps_itself_once: woke % manager(s) holding busted players', v_woken;
END
$body$;

COMMIT;
