-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902164610; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE SEAT TERM WAS SCANNING EVERY PAYOUT EVER MADE (2026-09-02, Phase 4 follow-up).
--
-- A REGRESSION I SHIPPED ONE RUN EARLIER, AND THE WORST KIND: a money check
-- that stopped running. That is the exact failure Phase 1 was built to catch.
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
-- and the hourly job evaluates 5,108 events in its 2-day window, so roughly
-- 19.1 MILLION buffer hits for that one term.
--
-- WHAT IT COST. pg_cron job 144 (tourney_money_conservation_hourly, 120s
-- statement timeout) had succeeded in 18-26 seconds on every run for hours:
--     11:12 ok 18.5s   12:12 ok 17.6s   13:12 ok 24.8s
--     14:12 ok 22.7s   15:12 ok 25.8s
-- The migration landed at 16:00:19. The very next run:
--     16:12 FAILED - canceling statement due to statement timeout
--                    CONTEXT: SQL function "fn_tournament_conservation_delta"
--
-- So the hourly tournament money check has been DOWN since 16:12, and would
-- have stayed down silently. It is worth saying plainly that the heartbeat did
-- not catch this and could not have: money_check_heartbeat is stamped by the
-- GameServer pass, which has never run, while this check is driven by pg_cron
-- job 144. A check can therefore be running, and failing, while its heartbeat
-- reads "never run" - which is a gap in the Phase 1 instrument, recorded here
-- and left for its owner rather than widened on the way past.
--
-- THE FIX is one partial expression index. Only 23 rows in the table qualify,
-- so it is tiny, and it is the narrowest thing that removes the scan:
-- everything already filters on source = 'satellite_seat' first.
--
-- seat_paid_out needs nothing: it filters on sp.tournament_id, which
-- idx_tournament_payouts_tournament already serves, and only then on source.
-- No index is added for it - this estate actively drops never-scanned indexes
-- (20260901125712, and the report-only guard at 20260901122027), so adding one
-- nothing reads would be adding future work for someone else.

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
