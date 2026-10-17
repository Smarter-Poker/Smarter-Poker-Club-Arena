-- ============================================================================
-- PRE-SPAWNED FREE BUYS FOLLOW THE HALF-HOUR BOARD
-- ============================================================================
--
-- Dan, 2026-10-16: the five Free Buys run "AT 8:30AM, 12:30PM 4:30PM 8:30PM
-- AND 12:30AM EVERY DAY", guarantees doubled (standard 500, Prime Time
-- feature 1,000). #7173 (merged 2026-10-17 01:45Z) taught the engine board
-- writer that spec, and by 10:45Z every active Free Buy SCHEDULE row read
-- :30 Chicago. WHAT #7173 DID NOT REACH, read from rows:
--
--   1. 28 OCCURRENCES ALREADY SPAWNED for 2026-10-17..19 (14 Midway chip,
--      14 Diamond Arena) still ran at :00 with the old guarantees (250,
--      Prime Time 500). Nothing conforms a pre-start spawned occurrence when
--      its schedule changes; the hourly freeBuyAudit has held "40 problem(s)
--      across 20 event(s)" open since 03:01Z, and the 8:30 AM slot was two
--      hours away.
--
--   2. A DUPLICATE SPAWN HAZARD. Spawn keys embed the slot time
--      (sched:2026-10-18:08:00). With schedules at :30, the spawner computes
--      unspent :30 keys for dates whose :00 keys are already spent; at
--      05:30Z it minted the first :30 rows for the fresh date 2026-10-20
--      (correct - no :00 twin exists there). Its horizon reaching back over
--      10-18/19 would have put two Morning Free Buys on the same board.
--
-- THE FIX, DATA ONLY, ONE TRANSACTION, EVERY NUMBER ASSERTED:
--
--   - The 14 Diamond events' guarantees are raised THROUGH THE EARMARK
--     LEDGER, never past it: each event's current 'guarantee:<id>' promise
--     is released in full and reopened at the doubled amount, under
--     fn_ca_diamond_earmark_guard's own availability and cap checks (read
--     before writing: house available 2,185,818; outstanding 107,700 of a
--     2,000,000 cap; per-event cap 1,000,000 - the +4,000 net raise is
--     covered many times over, and the guard still has the final word).
--   - Each of the 28 occurrences moves to its schedule's :30 start and
--     takes Dan's doubled guarantee (Chicago hour 20 -> 1000, every other
--     slot -> 500). Every one is a freeroll in REGISTERING with a zero,
--     unfinalized pool: no entrant paid anything, nothing is taken from
--     anybody, and the guarantee only grows. None starts within 20 minutes.
--     The chip rows' raise passes the ordinary union-bank headroom guard.
--   - Each occurrence's spawn key is renamed :00 -> :30, so the spawner
--     sees the :30 slot of those dates as already delivered and can never
--     seat a duplicate beside it. Dates beyond the pre-spawn horizon mint
--     :30 keys natively (2026-10-20 already has).
--
-- APPLY STATUS AND THE ONE OPEN GATE: a dry apply on 2026-10-17 ~10:55Z
-- passed every assertion and both money guards and was refused, correctly,
-- by fn_guard_managed_game_lifecycle ("This tournament cannot be modified
-- after a player has registered"), whose only exemption is the engine's
-- service_role. Every target is a freeroll whose registrants paid nothing
-- and whose event only improves (later start on Dan's own clock, larger
-- guarantee), and the 2026-10-16 fixed-board audit repriced locked
-- registered events "through the engine role" for exactly this shape - but
-- assuming the engine's claim is the owner's call, not an agent's. This
-- file waits for Dan's go-ahead (the transaction-local claim pattern of
-- 20260908043200 then applies it), or is superseded by the engine-side
-- root fix: the board writer conforming pre-spawned zero-paid occurrences
-- on its own resync.
--
-- The hourly Free Buy watch closes its own alert once the board matches
-- (2026-10-15 mechanism); nothing here is scheduled, retried or swept.
--
-- No DDL beyond a pg_temp scaffold: pure data, so no PostgREST reload and
-- no break-window gate. To be applied once to kuklfnapbkmacvwxktbh and
-- recorded under its filename version. Never reapply: the pre-asserts
-- refuse a second run (zero :00 rows remain).
--
-- @live-proof: (SELECT count(*) = 0 FROM public.tournaments t JOIN public.tournament_schedules s ON s.id = t.schedule_id WHERE s.name ILIKE '%Free Buy (NLH)' AND s.active AND t.status IN ('ANNOUNCED','REGISTERING') AND t.start_time > now() AND extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') = 0)
-- ============================================================================

DO $do$
DECLARE
  v_targets integer;
  v_diamond integer;
  v_keys integer;
  v_rows integer;
  r record;
  v_open bigint;
  v_new bigint;
BEGIN
  -- The affected set, locked. Predicate: an active Free Buy schedule's own
  -- occurrence, pre-start by more than 20 minutes, pool not finalized, still
  -- on the retired :00 Chicago minute.
  CREATE TEMP TABLE zz_fb_targets ON COMMIT DROP AS
  SELECT t.id AS tournament_id,
         t.schedule_id,
         t.start_time,
         extract(hour FROM t.start_time AT TIME ZONE 'America/Chicago')::int AS chi_hour,
         t.guaranteed_prize,
         COALESCE(t.prize_pool, 0) AS prize_pool,
         (c.asset = 'diamonds') AS is_diamond
    FROM public.tournaments t
    JOIN public.tournament_schedules s ON s.id = t.schedule_id
    JOIN public.clubs c ON c.id = t.club_id
   WHERE s.name ILIKE '%Free Buy (NLH)'
     AND s.active
     AND t.status IN ('ANNOUNCED','REGISTERING')
     AND NOT t.prize_pool_finalized
     AND t.start_time > now() + interval '20 minutes'
     AND extract(minute FROM t.start_time AT TIME ZONE 'America/Chicago') = 0
     FOR UPDATE OF t;

  SELECT count(*), count(*) FILTER (WHERE is_diamond)
    INTO v_targets, v_diamond FROM zz_fb_targets;
  IF v_targets <> 28 OR v_diamond <> 14 THEN
    RAISE EXCEPTION 'free buy conform expected 28 occurrences (14 Diamond), found % (%)',
      v_targets, v_diamond USING ERRCODE = 'P0404';
  END IF;

  -- The slots and old guarantees must be exactly the five-slot board as
  -- read, with zero pools: hours 0/8/12/16 at 250 and hour 20 at 500.
  IF EXISTS (SELECT 1 FROM zz_fb_targets
              WHERE prize_pool <> 0
                 OR NOT ((chi_hour IN (0,8,12,16) AND guaranteed_prize = 250.00)
                      OR (chi_hour = 20 AND guaranteed_prize = 500.00))) THEN
    RAISE EXCEPTION 'free buy conform met a slot, pool or guarantee it does not know'
      USING ERRCODE = 'P0404';
  END IF;

  -- Every target owns exactly one spawn row whose key ends in :00, and no
  -- schedule already holds the :30 spelling of that key.
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

  -- THE DIAMOND PROMISES GROW THROUGH THEIR OWN LEDGER. Each event's open
  -- 'guarantee:<id>' earmark is released in full and reopened at the doubled
  -- amount; the append-only guard re-checks the house availability and both
  -- caps on every 'open', so a budget this transaction cannot cover aborts
  -- it whole, loudly, before any row has moved.
  FOR r IN SELECT * FROM zz_fb_targets WHERE is_diamond ORDER BY tournament_id LOOP
    v_open := public.fn_ca_diamond_earmark_open('guarantee:' || r.tournament_id::text);
    IF v_open <> r.guaranteed_prize::bigint THEN
      RAISE EXCEPTION 'diamond free buy % promises % but its earmark holds %',
        r.tournament_id, r.guaranteed_prize, v_open USING ERRCODE = 'P0404';
    END IF;
    v_new := CASE r.chi_hour WHEN 20 THEN 1000 ELSE 500 END;
    INSERT INTO public.ca_diamond_house_earmarks
      (at, entry, earmark_key, purpose, amount, tournament_id, reason)
    VALUES
      (now(), 'release', 'guarantee:' || r.tournament_id::text, 'guarantee', v_open,
       r.tournament_id,
       'Released to reopen at the doubled half-hour-board guarantee (migration 20261017105003)'),
      (now(), 'open', 'guarantee:' || r.tournament_id::text, 'guarantee', v_new,
       r.tournament_id,
       'Dan 2026-10-16: Free Buy guarantees doubled; pre-spawned occurrence conformed by migration 20261017105003');
  END LOOP;

  -- The move: +30 minutes onto the same slot, Dan's doubled guarantee. The
  -- guarantee trigger re-checks every row - the Diamond earmarks above and
  -- the Midway union bank cover it, or this aborts.
  UPDATE public.tournaments t
     SET start_time = t.start_time + interval '30 minutes',
         guaranteed_prize = CASE z.chi_hour WHEN 20 THEN 1000.00 ELSE 500.00 END,
         updated_at = now()
    FROM zz_fb_targets z
   WHERE t.id = z.tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 28 THEN
    RAISE EXCEPTION 'free buy conform moved % occurrences, expected 28', v_rows
      USING ERRCODE = 'P0404';
  END IF;

  -- The keys follow the events they spent.
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

  -- The board now matches the written spec, and every moved row reads back
  -- at :30 with its tier and, for a Diamond event, an earmark that covers it.
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
        OR t.guaranteed_prize <> CASE z.chi_hour WHEN 20 THEN 1000.00 ELSE 500.00 END
        OR (z.is_diamond AND public.fn_ca_diamond_earmark_open('guarantee:' || t.id::text)
              <> CASE z.chi_hour WHEN 20 THEN 1000 ELSE 500 END)
  ) THEN
    RAISE EXCEPTION 'a moved Free Buy occurrence does not read back at :30 with its covered tier'
      USING ERRCODE = 'P0404';
  END IF;
END $do$;
