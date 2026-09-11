-- RULING R2 - $100 Freeroll 12:00 PM 7aa16fa7: wake the stalled manager.
-- One transaction. Writes exactly one durable tournament_manager_wakes row
-- (reason 'rebuy', the same reason the 07:23 repair used). Moves no chips,
-- no seats and no money. The wake makes the engine run one full sweep, whose
-- balance stage breaks three one-player tables into the fourth.
-- Must commit OUTSIDE the :53-:00 maintenance freeze (a sweep that runs inside
-- the freeze skips seat movement again - that is the defect being worked
-- around), hence the :50-:03 refusal below.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $window$
BEGIN
  IF extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') >= 50
     OR extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC') < 3 THEN
    RAISE EXCEPTION 'R2 refuses to run inside the :50-:03 UTC break window';
  END IF;
END $window$;

DO $pre$
DECLARE
  v_t constant uuid := '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d';
  n integer;
BEGIN
  PERFORM 1 FROM public.tournaments t
   WHERE t.id = v_t AND t.status = 'RUNNING' AND t.prize_pool = 204.40 AND t.prize_pool_finalized;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: not the RUNNING 204.40 event'; END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations WHERE tournament_id = v_t)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id = v_t) THEN
    RAISE EXCEPTION 'PRE: money or a terminal receipt already exists';
  END IF;
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = v_t AND e.prize_balance = 204.40 AND e.fee_balance = 11.60 AND e.closed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRE: escrow is not the untouched 204.40 / 11.60 bank'; END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id = v_t AND state = 'pending') THEN
    RAISE EXCEPTION 'PRE: a pending knockout generation exists';
  END IF;
  SELECT count(*) INTO n FROM public.tournament_players
   WHERE tournament_id = v_t AND status = 'eliminated' AND position IS NOT NULL AND elimination_sequence IS NOT NULL;
  IF n <> 381 THEN RAISE EXCEPTION 'PRE: % positioned eliminated rows, expected 381', n; END IF;
  -- The stall: four players, each alone on a distinct live table, felt = mirror.
  SELECT count(*) INTO n
    FROM public.tournament_players tp
    JOIN public.table_seats s ON s.user_id = tp.user_id AND s.left_at IS NULL
    JOIN public.tables tb ON tb.id = s.table_id AND tb.tournament_id = v_t
   WHERE tp.tournament_id = v_t AND tp.status = 'playing'
     AND s.stack = tp.chips AND s.stack > 0
     AND tp.user_id IN ('a70a0d4c-232e-482d-898f-37518fe134bc','753e81a9-1513-4923-be2b-bd684ed7133c',
                        '9585521c-a98d-4880-a915-c7248289a162','55ee6465-bdc1-4eb1-b7fd-7630ff315e04')
     AND (SELECT count(*) FROM public.table_seats o WHERE o.table_id = s.table_id AND o.left_at IS NULL) = 1;
  IF n <> 4 THEN RAISE EXCEPTION 'PRE: % of the 4 survivors sit alone on a live table with felt = mirror', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_players WHERE tournament_id = v_t AND status = 'playing';
  IF n <> 4 THEN RAISE EXCEPTION 'PRE: % playing rows, expected 4', n; END IF;
END $pre$;

SELECT public.fn_emit_tournament_manager_wake('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d', 'rebuy') AS wake_id;

DO $post$
BEGIN
  PERFORM 1 FROM public.tournament_manager_wakes
   WHERE tournament_id = '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' AND reason = 'rebuy' AND consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST: no pending wake row'; END IF;
END $post$;
COMMIT;
