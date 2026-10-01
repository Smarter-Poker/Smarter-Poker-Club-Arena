-- 20261001225325_the_september_eight_games_commit_the_launch_their_engine_los.sql
--
-- THE SEPTEMBER 8 GAMES COMMIT THE LAUNCH THEIR ENGINE LOST (2026-10-01)
--
-- WHAT WAS READ (production rows, 2026-10-01 ~22:30 UTC, read-only):
--   30 events created and dealt on 2026-09-08 still read status REGISTERING,
--   started_at NULL, prize_pool_finalized = true, every entry paid into an
--   open escrow (tournament_escrow.prize_balance = prize_pool, nothing out):
--     13 Spins (3 seats, drawn multiplier 2x, winner takes all)     446.00
--     13 heads-up Sit & Gos (winner takes all)                       777.10
--      4 heads-up duel satellites (097e3601, 20c75b67, 92c93927,
--        a4262ba0; one seat each into a target that is now
--        COMPLETED, so the seat is delivered as its cash ticket)     370.50
--   Total finalized pools held:                                     1,593.60
--   28 of them are decided: one entrant still playing with every live chip
--   on the one live seat, the others eliminated with places recorded.
--   Two Spins are NOT decided: 6d359f61 (645 v 555) and 8904c10b
--   (2034 v 1966) each hold two live stacks and one eliminated 3rd place.
--   No launch receipt, no terminal receipt, no payout row, no hand history
--   left (retention), no lease that survives a pass.
--
-- WHY THEY ARE STUCK: the engine that dealt them died before the launch's
-- RUNNING commit. Since then every pass starts a manager, sees "Only 1 of 2
-- player(s)" against a field that has already played, and stands down (engine
-- log 2026-10-01). The database's played-game recovery proof
-- (fn_prove_played_launch_recovery) needs hand_history rows that retention
-- has since removed, so the launch completion can never prove the field.
-- #5387 (first archived Spin) built a recovery admission for exactly ONE
-- event, 2aa4cba1, bound by CHECK constraint and a hard-coded winner, and it
-- has never been invoked: it cannot finish the other 29. Every finish
-- authority (fn_complete_tournament_terminal, fn_settle_satellite_tournament)
-- holds a one-tournament settlement lane per transaction, so one migration
-- cannot pay 30 events itself, and a payout written by hand is forbidden
-- (CLAUDE.md 10.9.2).
--
-- THE PATH (the 2026-09-11 lane D audit's proposal, completed for all 30):
-- commit exactly the step the launch lost, through the launch's own door: an
-- immutable tournament_launch_receipts row and the transaction-local
-- app.atomic_tournament_launch marker that only launch completion sets, so
-- the freeze guard admits REGISTERING -> RUNNING for these 30 ids and nothing
-- else. started_at is the moment the field was complete (the last paid entry,
-- or the Spin reveal after it), always before the first elimination; for
-- 2aa4cba1 it is the retained first-hand witness #5387 recorded. Then the
-- engine's own lanes finish each event in its own transaction, exactly as
-- they finished the September 8 Spins resumed on 09-21:
--   finishSeatFirstGamesThatAreOver (RUNNING > 5 min, silent > 3 min, <= 1
--   live stack) wakes the elimination sweep; the terminal authority pays the
--   survivor the event's first prize (heads-up and 2x Spin: the whole
--   finalized pool) and records the eliminated entrant(s) in their places;
--   the satellite authority delivers the seat as its cash ticket (target
--   buy-in + fee: 200.00 / 20.00) to the winner and the pool remainder
--   (85.00 / 8.50) to second place, its own rule for a closed target; every
--   one closes escrow to exact zero, releases seats and tables and writes
--   its terminal receipt. The two undecided Spins resume dealing and finish
--   by play, which is their rule.
-- Nobody is paid by this file, so nobody can be paid twice; nothing is taken
-- from anybody; rake already taken stays where it is.
--
-- GUARDS: refuses inside the break window or an announced maintenance
-- window; every event must match, field for field, the md5 pre-image read on
-- 2026-10-01 (status, start, pool, payout contract, roster with chips and
-- places, live seats and stacks, escrow banks); none may own a launch
-- receipt, terminal receipt or payout row. Post-image: all 30 RUNNING with
-- the stated started_at, receipts completed, roster/seats/escrow unchanged.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_reason text;
  v_row record;
  v_launch uuid;
  v_rest_before text;
  v_rest_after text;
  v_full text;
  v_n integer := 0;
  v_total numeric;
  v_set jsonb;
  v_rest jsonb := '{}'::jsonb;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SEP8_LAUNCH_COMMIT_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;

  -- id, md5 pre-image read 2026-10-01, started_at of the field that was dealt
  v_set := $set$[
    {"id":"00f57d7b-db16-4307-8e40-a47e24d4aa29","preimage":"0f685689b7837b27d7e5dacd17afbde5","started_at":"2026-09-08 14:48:30.508131+00"},
    {"id":"097e3601-ccf9-4035-af40-eb35068d2652","preimage":"16d5ad319efa93b63230802f3638b508","started_at":"2026-09-08 14:42:36.201936+00"},
    {"id":"106c4e13-0da7-4b62-b849-119781d25d4f","preimage":"0534ad158c4977c6bb6edf3f80b8f717","started_at":"2026-09-08 14:45:14.369415+00"},
    {"id":"20c75b67-7f78-4b29-b7df-9594faf62af0","preimage":"e4ceb53cb72391e7d46d9654f66b878f","started_at":"2026-09-08 14:50:57.103603+00"},
    {"id":"2aa4cba1-506f-426b-a1ba-d8e22e018533","preimage":"2bfad7b11141e0c19b9636e6cdb73a6b","started_at":"2026-09-08 14:48:56.020255+00"},
    {"id":"2d6dadb7-d1cb-4e03-980f-41fafce98afd","preimage":"49a0bc96bc7d54f1b9df01a60c77d6ec","started_at":"2026-09-08 14:50:50.155044+00"},
    {"id":"3843907b-dc12-40c3-9641-d2c66f4ebe7c","preimage":"b2a383296943ddd69ef1ed233569a912","started_at":"2026-09-08 14:45:08.984151+00"},
    {"id":"44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa","preimage":"72acd7ba2e982935ca7f2b7e26cbb5eb","started_at":"2026-09-08 14:37:24.125+00"},
    {"id":"482e90bb-ef9d-4135-9067-9f0332c94142","preimage":"544c7c647c400d8611448b95ee69bc33","started_at":"2026-09-08 14:47:25.797+00"},
    {"id":"659d3ec6-c584-42ea-956d-5fc2004ba566","preimage":"c2ffca94946ed30cc84fb20b5422e398","started_at":"2026-09-08 14:46:43.26269+00"},
    {"id":"6d359f61-d681-49ba-82f3-00493178e5b3","preimage":"9b0e51cd4bd57d287627b2380d14117f","started_at":"2026-09-08 14:46:44.652+00"},
    {"id":"7284506c-093c-491a-8da7-5816bf1ccccf","preimage":"4661aa8d8e71beb4e851562d35fd6246","started_at":"2026-09-08 14:48:34.647+00"},
    {"id":"8904c10b-6a47-4934-bdf2-def1b1e76f0b","preimage":"9593df8e7a0f1c0f0e6ad8ab377a2f26","started_at":"2026-09-08 13:46:11.628+00"},
    {"id":"8c6a20c5-a422-4177-8b93-efa371d5c14d","preimage":"af3dbfe05d091574c2ac2ab658ece1ee","started_at":"2026-09-08 14:46:02.189607+00"},
    {"id":"8d5969da-df76-44fa-8c83-5608b844ca06","preimage":"bc5fd5531f8905752a4b4ccdb106e58e","started_at":"2026-09-08 14:39:30.684+00"},
    {"id":"90c4d93f-4577-4da2-bd9b-51b774019971","preimage":"1c399070c299cd0335307be86c361698","started_at":"2026-09-08 14:38:51.05798+00"},
    {"id":"92c93927-614f-4168-a1f9-918849c0be19","preimage":"6920f28b9a387c68ce31926773932df1","started_at":"2026-09-08 14:44:13.678166+00"},
    {"id":"95e43b6e-c1c9-445e-a1d9-cbe711e3bac1","preimage":"23b58aed199798a7f571dd209c28ad0d","started_at":"2026-09-08 14:36:39.796+00"},
    {"id":"9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8","preimage":"72ed422807e26bd9d4969d5c771f1f6b","started_at":"2026-09-08 14:44:46.359+00"},
    {"id":"a4262ba0-cd5f-4a94-a0f8-915a028cf3a7","preimage":"57a5301c2e418ee44645a11a42d08108","started_at":"2026-09-08 14:43:53.786944+00"},
    {"id":"ab4125bc-a85e-45c6-b0a7-22417d75c0c5","preimage":"377cd8bfb8b2261fbeef5ca38c176cf0","started_at":"2026-09-08 14:45:20.841112+00"},
    {"id":"b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99","preimage":"ab8d26737c898aaa6e8e6dd5333f4eee","started_at":"2026-09-08 14:46:19.311+00"},
    {"id":"b5fae1b3-b900-4670-85ef-76e3aa646734","preimage":"0ea255c8bee8f220ce78fe1ada304e41","started_at":"2026-09-08 14:47:09.369822+00"},
    {"id":"b67ab0cb-e2d6-4955-8f43-4bff32551400","preimage":"73a8e3b5b1b84913ba82321330f7ac81","started_at":"2026-09-08 14:40:33.711+00"},
    {"id":"c2fd1c7e-9572-4b95-90dd-3b999777a145","preimage":"29aa1b9dcd684b96f63176c877056a5f","started_at":"2026-09-08 14:47:25.844+00"},
    {"id":"dae6db50-4f35-4ffd-b8f5-b9f95d104c10","preimage":"4363c0922ee58005c0f949735d8684c0","started_at":"2026-09-08 14:51:09.805733+00"},
    {"id":"e62a97cc-40a8-4d70-a89d-04ca4cc20834","preimage":"78d09740131ad7ce8120651727f4d961","started_at":"2026-09-08 14:47:57.40071+00"},
    {"id":"efd5455d-d188-4171-becb-1d35b016d06a","preimage":"4d44c5339d7a008ae0ab7370b833d224","started_at":"2026-09-08 14:40:42.444+00"},
    {"id":"f58d6375-4bb4-4f80-a673-0460fcf2c1be","preimage":"9739ac3241dea40b57138b2dd38a10c3","started_at":"2026-09-08 14:46:25.932645+00"},
    {"id":"f5a6896b-b739-40e0-9f73-680ee36bc532","preimage":"e5699cd99b9edbc2e69eb906b2623939","started_at":"2026-09-08 14:45:08.293818+00"}
  ]$set$::jsonb;

  SELECT count(*), sum(t.prize_pool) INTO v_n, v_total
    FROM public.tournaments t
   WHERE t.id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_set) e);
  IF v_n <> 30 OR v_total IS DISTINCT FROM 1593.60 THEN
    RAISE EXCEPTION 'SEP8_LAUNCH_SET_CHANGED: % events, % chips', v_n, v_total;
  END IF;

  FOR v_row IN SELECT (e->>'id')::uuid AS tournament_id, e->>'preimage' AS preimage,
                     (e->>'started_at')::timestamptz AS started_at
                FROM jsonb_array_elements(v_set) e ORDER BY 1 LOOP
    PERFORM 1 FROM public.tournaments WHERE id = v_row.tournament_id FOR UPDATE;

    SELECT md5(jsonb_build_object(
             'tournament', jsonb_build_object('status',t.status,'started_at',t.started_at,
               'prize_pool',t.prize_pool,'finalized',t.prize_pool_finalized,
               'spin_multiplier',t.spin_multiplier,'payout_structure',t.payout_structure,
               'satellite_target_id',t.satellite_target_id,'satellite_seats',t.satellite_seats,
               'buy_in_amount',t.buy_in_amount,'buy_in_fee',t.buy_in_fee,
               'format_contract',t.format_contract),
             'roster', r.roster, 'live_seats', r.live_seats, 'escrow', r.escrow)::text),
           md5(jsonb_build_object('roster', r.roster, 'live_seats', r.live_seats,
             'escrow', r.escrow, 'payout_structure', t.payout_structure::jsonb)::text)
      INTO v_full, v_rest_before
      FROM public.tournaments t
      CROSS JOIN LATERAL (SELECT
        (SELECT jsonb_agg(jsonb_build_array(p.id,p.user_id,p.status,p.chips,p.position,
                  p.eliminated_at,p.table_id,p.seat_number,p.prize) ORDER BY p.id)
           FROM public.tournament_players p WHERE p.tournament_id = t.id) AS roster,
        (SELECT jsonb_agg(jsonb_build_array(s.id,s.user_id,s.stack,s.seat_number) ORDER BY s.id)
           FROM public.table_seats s JOIN public.tables b ON b.id = s.table_id
          WHERE b.tournament_id = t.id AND s.left_at IS NULL) AS live_seats,
        (SELECT jsonb_build_array(e.gross_in,e.prize_balance,e.fee_balance,e.reserve_in,
                  e.reserve_out,e.prize_out,e.fee_out,e.bounty_balance,e.closed_at)
           FROM public.tournament_escrow e WHERE e.tournament_id = t.id) AS escrow) r
     WHERE t.id = v_row.tournament_id;
    IF v_full IS DISTINCT FROM v_row.preimage THEN
      RAISE EXCEPTION 'SEP8_LAUNCH_PREIMAGE_CHANGED: % (% <> %)',
        v_row.tournament_id, v_full, v_row.preimage USING ERRCODE = '40001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id = v_row.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id = v_row.tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = v_row.tournament_id)
       OR v_row.started_at >= (SELECT min(p.eliminated_at) FROM public.tournament_players p
                                WHERE p.tournament_id = v_row.tournament_id) THEN
      RAISE EXCEPTION 'SEP8_LAUNCH_LATER_AUTHORITY: %', v_row.tournament_id USING ERRCODE = '40001';
    END IF;
    v_rest := v_rest || jsonb_build_object(v_row.tournament_id::text, v_rest_before);

    v_launch := gen_random_uuid();
    INSERT INTO public.tournament_launch_receipts(tournament_id, launch_id, started_at)
    VALUES (v_row.tournament_id, v_launch, v_row.started_at);
    PERFORM set_config('app.atomic_tournament_launch',
      v_row.tournament_id::text || ':' || v_launch::text, true);
    UPDATE public.tournaments
       SET status = 'RUNNING', started_at = v_row.started_at
     WHERE id = v_row.tournament_id AND status = 'REGISTERING' AND started_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SEP8_LAUNCH_STATUS_MOVED: %', v_row.tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournament_launch_receipts
       SET completed_at = transaction_timestamp()
     WHERE tournament_id = v_row.tournament_id AND launch_id = v_launch AND completed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SEP8_LAUNCH_RECEIPT_NOT_COMPLETED: %', v_row.tournament_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.atomic_tournament_launch', '', true);

  -- Post-image: the launch and nothing else.
  FOR v_row IN SELECT (e->>'id')::uuid AS tournament_id, e->>'preimage' AS preimage,
                     (e->>'started_at')::timestamptz AS started_at
                FROM jsonb_array_elements(v_set) e ORDER BY 1 LOOP
    SELECT md5(jsonb_build_object('roster', r.roster, 'live_seats', r.live_seats,
             'escrow', r.escrow, 'payout_structure', t.payout_structure::jsonb)::text)
      INTO v_rest_after
      FROM public.tournaments t
      CROSS JOIN LATERAL (SELECT
        (SELECT jsonb_agg(jsonb_build_array(p.id,p.user_id,p.status,p.chips,p.position,
                  p.eliminated_at,p.table_id,p.seat_number,p.prize) ORDER BY p.id)
           FROM public.tournament_players p WHERE p.tournament_id = t.id) AS roster,
        (SELECT jsonb_agg(jsonb_build_array(s.id,s.user_id,s.stack,s.seat_number) ORDER BY s.id)
           FROM public.table_seats s JOIN public.tables b ON b.id = s.table_id
          WHERE b.tournament_id = t.id AND s.left_at IS NULL) AS live_seats,
        (SELECT jsonb_build_array(e.gross_in,e.prize_balance,e.fee_balance,e.reserve_in,
                  e.reserve_out,e.prize_out,e.fee_out,e.bounty_balance,e.closed_at)
           FROM public.tournament_escrow e WHERE e.tournament_id = t.id) AS escrow) r
     WHERE t.id = v_row.tournament_id
       AND t.status = 'RUNNING' AND t.started_at = v_row.started_at
       AND t.prize_pool_finalized
       AND EXISTS (SELECT 1 FROM public.tournament_launch_receipts l
                    WHERE l.tournament_id = t.id AND l.started_at = v_row.started_at
                      AND l.completed_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts x WHERE x.tournament_id = t.id);
    IF v_rest_after IS NULL OR v_rest_after IS DISTINCT FROM v_rest->>v_row.tournament_id::text THEN
      RAISE EXCEPTION 'SEP8_LAUNCH_POSTIMAGE: % moved more than its launch', v_row.tournament_id;
    END IF;
  END LOOP;
  RAISE NOTICE 'SEP8_LAUNCH_COMMITTED: 30 events RUNNING, 1593.60 in finalized pools handed to their finish authorities';
END
$mig$;

COMMIT;
