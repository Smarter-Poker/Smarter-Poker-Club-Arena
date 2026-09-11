-- ═══════════════════════════════════════════════════════════════════════════
--  FORTY GAMES DEALT ON 2026-09-08 NEVER LEFT REGISTERING (lane D, 2026-09-11)
--  NOT APPLIED. Settlement of damage already done (CLAUDE.md 10.9 / 10.11 step 3)
--  through the platform's own path, not a payout written by hand.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS READ (all from rows, 2026-09-11 13:5x-14:1x UTC):
--   40 tournaments, status REGISTERING, prize_pool_finalized = true,
--   started_at NULL, updated_at BEFORE their first hand, hands in hand_history
--   from 2026-09-08 12:49 to 14:53 UTC (the :53 stop of that hour's engine),
--   their tables 'running' with 1-2 live seats, 2,164.60 chips of finalized
--   pools unpaid. Every other REGISTERING row on the board (293) reads
--   prize_pool_finalized = false; the column is the exact separator.
--     1 MTT        "Breakfast Turbo" f370585d: 32 eliminated, 2 playing, one at
--                  0 chips and one at 430,255 - decided, winner unpaid (153.00)
--    17 heads-ups  one eliminated, one playing with chips - all decided,
--                  winners unpaid (1,147.60); 4 of the 17 are SATELLITES
--    22 spins      11 decided (two eliminated, one playing), 11 with two live
--                  stacks (864.00 in pools)
--   No launch receipts, no engine leases, escrow rows present for all 40.
--
-- WHY THEY ARE STUCK: the engine that dealt them died before the RUNNING
-- commit (the launch of that day dealt before it committed; today's
-- TournamentManagerBase commits RUNNING "after every durable launch step and
-- before any local dealer is admitted", and no such row exists after 09-08
-- 14:53 - measured). Since then GameServer.discoverTournaments read each one
-- as "past start, short of min_players" and topped it up every backoff (both
-- doors refuse: pool finalized), and no lane resumes a REGISTERING row. The
-- engine side of that is fixed in this lane (the ramp and the fills withhold
-- from a finalized pool); this file is what settles the 40.
--
-- THE PATH: put the status the launch should have committed on the row -
-- RUNNING, started_at = the first hand it dealt - and let the engine's own
-- lanes finish the job exactly as they would after any restart:
--   discoverRunningResumes adopts a RUNNING row with no manager -> resume()
--   adopts the running table, restores the level, admits the dealer;
--   finishSeatFirstGamesThatAreOver (RUNNING, started_at > 5 min ago, no hand
--   in 3 min, <= 1 live stack) wakes the elimination sweep on the decided
--   heads-ups and spins, whose finish pays the winner through the terminal
--   settlement authority; the elimination sweep on Breakfast Turbo eliminates
--   the 0-chip entrant and finishes it; the 11 undecided spins resume dealing.
-- Nobody is paid by this file, so nobody can be paid twice; nothing is taken
-- from anybody; every credit goes through the idempotent finish path.
--
-- WHAT THE STATUS FLIP RUNS, read from pg_trigger: fn_guard_tournament_start_
-- readiness (contract complete, guarantee funded - the pools are finalized),
-- fn_ca_fund_overlay_on_lock (a guarantee shortfall from the bank; all 40 are
-- at or over their guarantee, Breakfast Turbo 153.00 vs 150.00), the freeze
-- launch guard (apply outside the break window), and for the 4 SATELLITES
-- trg_capture_satellite_economics_on_start, which REFUSES a start whose pool
-- is below satellite_seats x (target buy-in + fee). Those four (097e3601 pool
-- 285.00, a4262ba0 28.50, 92c93927 28.50, 20c75b67 28.50) are therefore NOT
-- flipped here: their finish is
-- a seat award into a target that may itself have started since 09-08, and
-- that is the satellite settlement authority's decision, not a status flip.
-- Settle them separately after reading their targets.
--
-- PROBE FIRST (CLAUDE.md 11.5): run the DO block below inside ONE Supabase
-- MCP call with the final `RAISE EXCEPTION 'probe rolled back'` line kept.
-- An error is the success case. Then apply once, outside :50-:03 UTC, with
-- the RAISE removed. The block asserts every row's pre-state and aborts if
-- the board moved.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_ids uuid[] := ARRAY[
    -- the MTT
    'f370585d-40ea-4085-bb8f-c7e8c74f3fb4',
    -- heads-ups (SNG, not satellites)
    '90c4d93f-4577-4da2-bd9b-51b774019971','106c4e13-0da7-4b62-b849-119781d25d4f',
    'f5a6896b-b739-40e0-9f73-680ee36bc532','f58d6375-4bb4-4f80-a673-0460fcf2c1be',
    '659d3ec6-c584-42ea-956d-5fc2004ba566','b5fae1b3-b900-4670-85ef-76e3aa646734',
    'ab4125bc-a85e-45c6-b0a7-22417d75c0c5','8c6a20c5-a422-4177-8b93-efa371d5c14d',
    '3843907b-dc12-40c3-9641-d2c66f4ebe7c','00f57d7b-db16-4307-8e40-a47e24d4aa29',
    'dae6db50-4f35-4ffd-b8f5-b9f95d104c10','e62a97cc-40a8-4d70-a89d-04ca4cc20834',
    '2d6dadb7-d1cb-4e03-980f-41fafce98afd',
    -- spins
    'f3f050f1-569e-4fb6-859f-86b6092e682e','18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
    '808ef798-0942-4ce0-9ae1-eeefaaf4b0a9','e3f4e2ab-8397-43e8-8643-6cec3fff3a63',
    'b60c7add-6b38-4549-b091-601f64d118a0','5090c03b-2b36-456a-b301-485493280a51',
    '8904c10b-6a47-4934-bdf2-def1b1e76f0b','199a71a9-f364-4e90-a3ba-3cdcfb7755bc',
    '95e43b6e-c1c9-445e-a1d9-cbe711e3bac1','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa',
    '8d5969da-df76-44fa-8c83-5608b844ca06','b67ab0cb-e2d6-4955-8f43-4bff32551400',
    'efd5455d-d188-4171-becb-1d35b016d06a','f670ca7c-5134-4a22-9426-eea2601c300a',
    '9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','6d359f61-d681-49ba-82f3-00493178e5b3',
    '482e90bb-ef9d-4135-9067-9f0332c94142','c2fd1c7e-9572-4b95-90dd-3b999777a145',
    'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088','2aa4cba1-506f-426b-a1ba-d8e22e018533',
    '7284506c-093c-491a-8da7-5816bf1ccccf','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99'
  ]::uuid[];
  v_id uuid;
  v_t record;
  v_first_hand timestamptz;
  v_rows int;
  v_done int := 0;
BEGIN
  IF public.fn_ca_break_window_refuses_migrations(now()) THEN
    RAISE EXCEPTION 'inside the hourly break window - apply after :03';
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT t.id, t.status, t.started_at, t.prize_pool_finalized, t.tournament_type,
           t.satellite_target_id
      INTO v_t
      FROM public.tournaments t
     WHERE t.id = v_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % is missing', v_id;
    END IF;
    IF v_t.status <> 'REGISTERING' OR v_t.started_at IS NOT NULL
       OR NOT COALESCE(v_t.prize_pool_finalized, false) THEN
      RAISE EXCEPTION 'tournament % is not in the audited state (status %, started_at %, finalized %)',
        v_id, v_t.status, v_t.started_at, v_t.prize_pool_finalized;
    END IF;
    IF upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE' OR v_t.satellite_target_id IS NOT NULL THEN
      RAISE EXCEPTION 'tournament % is a satellite - settled separately', v_id;
    END IF;

    SELECT min(h.created_at) INTO v_first_hand
      FROM public.hand_history h
      JOIN public.tables tb ON tb.id = h.table_id
     WHERE tb.tournament_id = v_id;
    IF v_first_hand IS NULL THEN
      RAISE EXCEPTION 'tournament % dealt no hand - not a played row', v_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tables tb
                    WHERE tb.tournament_id = v_id AND tb.status <> 'closed') THEN
      RAISE EXCEPTION 'tournament % has no open table to resume on', v_id;
    END IF;

    UPDATE public.tournaments
       SET status = 'RUNNING',
           started_at = v_first_hand,
           updated_at = now()
     WHERE id = v_id
       AND status = 'REGISTERING'
       AND started_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % did not flip (% rows)', v_id, v_rows;
    END IF;
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 36 THEN
    RAISE EXCEPTION 'expected 36 rows, flipped %', v_done;
  END IF;

  -- PROBE MODE: keep this line for the rolled-back probe, remove it to apply.
  RAISE EXCEPTION 'probe rolled back: % rows would flip REGISTERING -> RUNNING', v_done;
END $$;

COMMIT;
