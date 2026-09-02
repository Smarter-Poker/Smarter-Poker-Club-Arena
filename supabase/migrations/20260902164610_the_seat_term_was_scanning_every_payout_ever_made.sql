-- THE SEAT TERM WAS SCANNING EVERY PAYOUT EVER MADE (2026-09-02, Phase 4 follow-up).
--
-- A REGRESSION I SHIPPED ONE MIGRATION EARLIER, AND THE WORST KIND: a money
-- check that stopped running. That is the exact failure Phase 1 was built to
-- catch, reintroduced by the phase that came after it.
--
-- 20260902160019 taught fn_tournament_conservation_delta to see a satellite
-- seat. Its seat_income term reads
--
--     WHERE sp.source = 'satellite_seat'
--       AND sp.metadata->>'satellite_target_id' = t.id::text
--
-- and tournament_payouts carries an index on tournament_id, on
-- (tournament_id, position), on (user_id, paid_at) and on idempotency_key -
-- and NONE on source, and none on that metadata key. So the term seq-scanned
-- the whole table once per tournament evaluated.
--
-- MEASURED, not estimated (EXPLAIN ANALYZE BUFFERS, one tournament):
--     Seq Scan on tournament_payouts   3,736 buffers
--     Rows Removed by Filter           85,309   (of 85,331; 23 qualify)
-- and the hourly job evaluates 5,108 events in its 2-day window: roughly
-- 19.1 MILLION buffer hits for that one term.
--
-- WHAT IT COST. TWO hourly money jobs, both of which had been healthy all day:
--
--   pg_cron 144  tourney_money_conservation_hourly (120s timeout)
--       11:12 ok 18.5s  12:12 ok 17.6s  13:12 ok 24.8s
--       14:12 ok 22.7s  15:12 ok 25.8s
--       16:12 FAILED - canceling statement due to statement timeout
--                      CONTEXT: SQL function "fn_tournament_conservation_delta"
--
--   pg_cron 231  ca-pay-backed-payout-shortfalls-hourly
--       12:26 ok 40s  13:26 ok 46s  14:26 ok 43s  15:26 ok 86s
--       16:26 FAILED - same timeout, same function, reached through
--                      fn_pay_backed_payout_shortfalls line 10
--
-- The migration landed at 16:00:19, between the 15:xx successes and the 16:xx
-- failures, on both jobs. 231 is the one that PAYS PLAYERS a backed shortfall,
-- so one hourly cycle of back-pay did not happen. Nothing is permanently lost -
-- the job is hourly and idempotent, and the next healthy run pays whatever is
-- still owed - but it is a missed cycle and it is recorded as one.
--
-- (pg_cron 229, the cash-pot check, also failed at 15:34. That is NOT this: it
-- predates the migration by half an hour, its timeout is inside a hand_history
-- query, and it succeeded again at 16:34 without help. Not every red job in the
-- window is yours; check the clock before claiming one.)
--
-- THE HEARTBEAT COULD NOT HAVE CAUGHT THIS, and that is worth writing down.
-- money_check_heartbeat is stamped by the GameServer pass, which has never run
-- (all seven rows still read run_count = 0). These checks are driven by pg_cron
-- instead. So a check can be running hourly, and failing hourly, while its
-- heartbeat says "never run" - the instrument and the thing it measures are on
-- different wires. Recorded for the Phase 1 owner; not widened here, because
-- guessing at someone else's instrument is how the last three phases each
-- acquired a defect.
--
-- THE FIX is one partial expression index. Only 23 of 85,331 rows qualify, so
-- it is tiny, and it is the narrowest thing that removes the scan.
--
-- MEASURED AFTER (same query, same row):
--     Seq Scan 3,736 buffers, 987.9 ms  ->  Index Scan 4 buffers, 0.24 ms
-- and across 400 events of the real window the two seat terms now cost about
-- 5 buffers each per event - roughly a tenth of the delta's total cost, where
-- before the index they were seventy times the whole rest of the query.
--
-- seat_paid_out needs no index of its own: it filters on sp.tournament_id,
-- which idx_tournament_payouts_tournament already serves, and only then on
-- source. None is added - this estate actively drops never-scanned indexes
-- (20260901125712, and the report-only guard at 20260901122027), so shipping
-- one that nothing reads would be leaving future work for someone else.

CREATE INDEX IF NOT EXISTS idx_tournament_payouts_satellite_target
  ON public.tournament_payouts ((metadata->>'satellite_target_id'))
  WHERE source = 'satellite_seat';

COMMENT ON INDEX public.idx_tournament_payouts_satellite_target IS
  'Serves fn_tournament_conservation_delta seat_income. Without it that term '
  'seq-scans all 85k payouts per tournament and the hourly conservation cron '
  'times out (measured 2026-09-02: 3,736 buffers x 5,108 events).';

DO $assert$
DECLARE
  v_has_index integer;
  v_target    numeric;
  v_bad_sats  integer;
BEGIN
  -- (a) The index exists, under the name the comment and the law test expect.
  SELECT count(*) INTO v_has_index
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename  = 'tournament_payouts'
     AND indexname  = 'idx_tournament_payouts_satellite_target';
  IF v_has_index <> 1 THEN
    RAISE EXCEPTION 'the satellite-target index was not created';
  END IF;

  -- (b) CORRECTNESS IS UNCHANGED. An index must not move a number. These are
  --     the two figures 20260902160019 measured and asserted; if either has
  --     moved, something other than performance changed and this migration is
  --     not what it says it is.
  SELECT public.fn_tournament_conservation_delta('dfae9288-40e2-485d-8c97-a13dd53ab483')
    INTO v_target;
  IF v_target IS DISTINCT FROM -180.00 THEN
    RAISE EXCEPTION
      'the satellite target now reads %, expected -180.00 - the index changed a number', v_target;
  END IF;

  SELECT count(*) INTO v_bad_sats
    FROM public.tournaments t
   WHERE COALESCE(t.variant, '') = 'satellite'
     AND EXISTS (SELECT 1 FROM public.tournament_payouts sp
                  WHERE sp.source = 'satellite_seat' AND sp.tournament_id = t.id)
     AND abs(COALESCE(public.fn_tournament_conservation_delta(t.id), 0)) > 0.05;
  IF v_bad_sats > 0 THEN
    RAISE EXCEPTION 'satellites that paid seats no longer balance: %', v_bad_sats;
  END IF;

  RAISE NOTICE 'seat index in place; target still -180.00; all seat-paying satellites still 0.00';
END;
$assert$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (not executed). DROP INDEX public.idx_tournament_payouts_satellite_target;
-- Do not run it without also reverting 20260902160019: the delta's seat_income
-- term without this index is what took both hourly jobs down.
-- ---------------------------------------------------------------------------
