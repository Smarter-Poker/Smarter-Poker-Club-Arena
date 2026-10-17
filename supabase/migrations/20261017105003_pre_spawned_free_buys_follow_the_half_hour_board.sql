-- ============================================================================
-- PRE-SPAWNED FREE BUYS FOLLOW THE HALF-HOUR BOARD
-- ============================================================================
--
-- APPLIED to kuklfnapbkmacvwxktbh at 2026-10-17 ~11:0xZ and recorded under
-- version 20261017105003. This file is the EXACT text that ran. Never reapply:
-- the first pre-assert (28 targets) refuses a second run.
--
-- Dan, 2026-10-16: the five Free Buys run "AT 8:30AM, 12:30PM 4:30PM 8:30PM
-- AND 12:30AM EVERY DAY", guarantees doubled (standard 500, Prime Time
-- feature 1,000). #7173 (merged 2026-10-17 01:45Z) taught the engine board
-- writer that spec, and by 10:45Z every active Free Buy SCHEDULE row read
-- :30 Chicago. WHAT #7173 DID NOT REACH, read from rows:
--
--   1. 28 OCCURRENCES ALREADY SPAWNED for 2026-10-17..19 (14 Midway chip,
--      14 Diamond Arena) still ran at :00. Nothing conforms a pre-start
--      spawned occurrence when its schedule changes; the hourly freeBuyAudit
--      had held "40 problem(s) across 20 event(s)" open since 03:01Z, and the
--      8:30 AM slot was two hours away.
--
--   2. A DUPLICATE SPAWN HAZARD. Spawn keys embed the slot time
--      (sched:2026-10-18:08:00). With schedules at :30, the spawner computes
--      unspent :30 keys for dates whose :00 keys are already spent; at
--      05:30Z it minted the first :30 rows for the fresh date 2026-10-20
--      (correct - no :00 twin exists there). Its horizon reaching back over
--      10-18/19 would have put two Morning Free Buys on the same board.
--
-- WHAT THIS MIGRATION MOVES, AND THE RULING THAT NARROWED IT. The draft also
-- doubled the 28 occurrences' guarantees (through the Diamond earmark ledger
-- for the 14 Diamond events). Production refused that, twice, each refusal a
-- law this file honors rather than works around:
--
--   * fn_guard_managed_game_lifecycle ("This tournament cannot be modified
--     after a player has registered") locks a registered event against every
--     caller but the engine. Dan was given the three options and answered
--     2026-10-17: "THIS IS ON YOU TO DECIDE WHATS BEST FOR US, YOU CAN MAKE
--     THE CHOICE. GET THIS FINISHED UP." - so this transaction carries the
--     engine's transaction-local claim (pattern 20260908043200): the conform
--     IS the engine's board catching up with its own schedule.
--
--   * trg_freeze_registered_tournament_settlement_contract then refused the
--     guarantee raise itself: "settlement class, guarantee, Bubble Protection
--     and buy-in are frozen after its first entrant". That trigger binds the
--     engine too, deliberately - the 2026-10-16 fixed-board audit records it
--     refusing any change to a funded contract, CORRECTLY. A registered
--     player's advertised contract is immutable, even when the change is an
--     improvement. So the 28 transition events (2026-10-17..19) keep their
--     advertised 250/500 guarantees; every occurrence from 2026-10-20 onward
--     is minted from the schedule and carries Dan's doubled 500/1000 tier
--     natively. The hourly freeBuyAudit will keep reporting the transition
--     events' guarantee lines through 10-19 - that is the contract law
--     speaking, not an unfixed defect - and falls silent as they play out.
--
-- WHAT RAN: times and keys only, one transaction, every number asserted.
--   - Each of the 28 occurrences moves +30 minutes onto its own slot (Dan's
--     own clock: 8:30a/12:30p/4:30p/8:30p/12:30a Chicago). Start time is not
--     part of the frozen settlement contract; every event was REGISTERING,
--     pool zero and unfinalized, more than 20 minutes from starting, and a
--     later start takes nothing from anyone.
--   - Each occurrence's spawn key is renamed :00 -> :30, so the spawner sees
--     the :30 slot of those dates as already delivered and can never seat a
--     duplicate beside it.
--
-- No DDL beyond a pg_temp scaffold: pure data, so no PostgREST reload and no
-- break-window gate.
--
-- @live-proof: (SELECT count(*) = 0 FROM public.tournaments t JOIN public.tournament_schedules s ON s.id = t.schedule_id WHERE s.name ILIKE '%Free Buy (NLH)' AND s.active AND t.status IN ('ANNOUNCED','REGISTERING') AND t.start_time > now() AND extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') = 0)
-- ============================================================================

DO $do$
DECLARE
  v_targets integer;
  v_keys integer;
  v_rows integer;
BEGIN
  -- THE ENGINE ROLE MAKES THIS EDIT (Dan's go-ahead 2026-10-17; precedent
  -- 20260908043200). Transaction-local: nothing after COMMIT carries it.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- The affected set, locked. Predicate: an active Free Buy schedule's own
  -- occurrence, pre-start by more than 20 minutes, pool not finalized, still
  -- on the retired :00 Chicago minute.
  CREATE TEMP TABLE zz_fb_targets ON COMMIT DROP AS
  SELECT t.id AS tournament_id,
         t.schedule_id,
         t.start_time,
         extract(hour FROM t.start_time AT TIME ZONE 'America/Chicago')::int AS chi_hour,
         t.guaranteed_prize
    FROM public.tournaments t
    JOIN public.tournament_schedules s ON s.id = t.schedule_id
   WHERE s.name ILIKE '%Free Buy (NLH)'
     AND s.active
     AND t.status IN ('ANNOUNCED','REGISTERING')
     AND NOT t.prize_pool_finalized
     AND t.start_time > now() + interval '20 minutes'
     AND extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') = 0
     FOR UPDATE OF t;

  SELECT count(*) INTO v_targets FROM zz_fb_targets;
  IF v_targets <> 28 THEN
    RAISE EXCEPTION 'free buy conform expected 28 pre-spawned :00 occurrences, found %', v_targets
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (SELECT 1 FROM zz_fb_targets
              WHERE NOT ((chi_hour IN (0,8,12,16) AND guaranteed_prize = 250.00)
                      OR (chi_hour = 20 AND guaranteed_prize = 500.00))) THEN
    RAISE EXCEPTION 'free buy conform met a slot or guarantee it does not know'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_keys
    FROM public.tournament_schedule_spawns sp
    JOIN zz_fb_targets z ON z.tournament_id = sp.tournament_id
   WHERE sp.spawn_key LIKE '%:00';
  IF v_keys <> 28 THEN
    RAISE EXCEPTION 'free buy conform expected 28 spendable :00 keys, found %', v_keys
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_schedule_spawns sp
      JOIN zz_fb_targets z ON z.tournament_id = sp.tournament_id
      JOIN public.tournament_schedule_spawns other
        ON other.spawn_key = regexp_replace(sp.spawn_key, ':00$', ':30')
  ) THEN
    RAISE EXCEPTION 'a :30 key already exists for a slot this migration moves'
      USING ERRCODE = 'P0404';
  END IF;

  -- The move: +30 minutes onto the same slot. Guarantees are NOT touched:
  -- they are part of the settlement contract frozen at the first entrant.
  UPDATE public.tournaments t
     SET start_time = t.start_time + interval '30 minutes',
         updated_at = now()
    FROM zz_fb_targets z
   WHERE t.id = z.tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 28 THEN
    RAISE EXCEPTION 'free buy conform moved % occurrences, expected 28', v_rows
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_schedule_spawns sp
     SET spawn_key = regexp_replace(sp.spawn_key, ':00$', ':30')
    FROM zz_fb_targets z
   WHERE sp.tournament_id = z.tournament_id
     AND sp.spawn_key LIKE '%:00';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 28 THEN
    RAISE EXCEPTION 'free buy conform renamed % keys, expected 28', v_rows
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.tournament_schedules s ON s.id = t.schedule_id
     WHERE s.name ILIKE '%Free Buy (NLH)' AND s.active
       AND t.status IN ('ANNOUNCED','REGISTERING')
       AND t.start_time > now()
       AND extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') = 0
  ) THEN
    RAISE EXCEPTION 'a future Free Buy occurrence still starts on the hour'
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournaments t JOIN zz_fb_targets z ON z.tournament_id = t.id
     WHERE extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') <> 30
        OR t.guaranteed_prize IS DISTINCT FROM z.guaranteed_prize
  ) THEN
    RAISE EXCEPTION 'a moved Free Buy occurrence does not read back at :30 with its frozen guarantee'
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
END $do$;
