-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830200538; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Close out the Sunday $200 Deep Stack run that died in the Supabase RESIZING
-- window, and stand the same event back up for 21:00 UTC (4PM America/Chicago).
--
-- RESET IN PLACE, deliberately. Fifteen completed satellites and eleven still
-- REGISTERING carry satellite_target_id = dfae9288. Creating a replacement row
-- would point every one of those at a dead event, so the same row is reused and
-- all that targeting stays intact.
--
-- The payouts of the dead run were reversed first (see
-- 20260830_reverse_dfae9288_dead_run_payouts_v2): 20,880 returned to treasury,
-- every prize mark cleared. This migration must not run before that one, and
-- asserts so.
--
-- prize_pool stays at 20,880. That money was collected as buy-ins from the
-- field and never refunded, so the relaunch is funded by the same entries;
-- nobody is charged twice and the 20,000 guarantee is already covered.
--
-- SEAT STACKS ARE ZEROED BEFORE left_at IS SET. The trigger on table_seats
-- records every exit of a NON-ZERO stack into ca_seat_stack_exits so chips
-- cannot leave the felt unnoticed. These are tournament chips, not wallet
-- chips, and the event is being wiped — releasing 56 live seats at full stack
-- would file 56 false "unaccounted seat exit" criticals against the nightly
-- reconciler. Zeroing first is both the truthful end state (a registered
-- player holds 0 chips until the event starts) and quiet to the audit.

DO $$
DECLARE
  v_tid        uuid := 'dfae9288-40e2-485d-8c97-a13dd53ab483';
  v_reversed   int;
  v_seats      int;
  v_tables     int;
  v_players    int;
  v_prizes     int;
  v_start      timestamptz := '2026-08-30 21:00:00+00';
BEGIN
  -- Refuse to run unless the money was put back first.
  SELECT count(*) INTO v_reversed FROM chip_ledger
   WHERE description = 'reversal: dfae9288 dead-run payout returned to treasury';
  IF v_reversed <> 9 THEN
    RAISE EXCEPTION 'Payout reversal has not been applied (% rows) — refusing to relaunch', v_reversed;
  END IF;

  SELECT count(*) INTO v_prizes FROM tournament_players
   WHERE tournament_id = v_tid AND prize > 0;
  IF v_prizes > 0 THEN
    RAISE EXCEPTION '% prize mark(s) still set — refusing to relaunch', v_prizes;
  END IF;

  -- 1. Release every live seat, stack zeroed first (see header).
  UPDATE table_seats ts
     SET stack = 0
    FROM tables tb
   WHERE tb.id = ts.table_id AND tb.tournament_id = v_tid AND ts.left_at IS NULL;

  UPDATE table_seats ts
     SET left_at = now()
    FROM tables tb
   WHERE tb.id = ts.table_id AND tb.tournament_id = v_tid AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_seats = ROW_COUNT;

  -- 2. Close every table so the start path builds a fresh, correctly-sized
  --    fleet rather than resuming half-broken ones (8 were already 'closed'
  --    while still holding live seats — the orphan shape this clears).
  UPDATE tables SET status = 'closed'
   WHERE tournament_id = v_tid AND status <> 'closed';
  GET DIAGNOSTICS v_tables = ROW_COUNT;

  -- 3. Put the field back to a clean pre-start registration.
  --    Matches a healthy REGISTERING event exactly: chips 0, no position.
  UPDATE tournament_players
     SET status = 'registered', position = NULL, chips = 0, prize = 0
   WHERE tournament_id = v_tid;
  GET DIAGNOSTICS v_players = ROW_COUNT;

  -- 4. Stand the event back up for 21:00 UTC.
  UPDATE tournaments
     SET status               = 'REGISTERING',
         start_time           = v_start,
         started_at           = NULL,
         ended_at             = NULL,
         current_level        = 0,
         level_started_at     = NULL,
         break_started_at     = NULL,
         break_ends_at        = NULL,
         prize_pool_finalized = false,
         current_players      = (SELECT count(*) FROM tournament_players WHERE tournament_id = v_tid),
         updated_at           = now()
   WHERE id = v_tid;

  -- 5. Post-conditions.
  PERFORM 1 FROM tournaments
   WHERE id = v_tid AND status = 'REGISTERING' AND start_time = v_start
     AND started_at IS NULL AND current_level = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament did not reset to the expected pre-start shape';
  END IF;

  IF EXISTS (SELECT 1 FROM table_seats ts JOIN tables tb ON tb.id = ts.table_id
              WHERE tb.tournament_id = v_tid AND ts.left_at IS NULL) THEN
    RAISE EXCEPTION 'Live seats remain after close-out';
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_players
              WHERE tournament_id = v_tid AND (position IS NOT NULL OR prize <> 0 OR status <> 'registered')) THEN
    RAISE EXCEPTION 'Field did not reset to a clean registration';
  END IF;

  RAISE NOTICE 'Closed out: % seats released, % tables closed, % players re-registered. Relaunch %',
    v_seats, v_tables, v_players, v_start;
END $$;
