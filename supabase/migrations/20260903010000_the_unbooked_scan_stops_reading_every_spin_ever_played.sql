-- THE UNBOOKED SCAN STOPS READING EVERY SPIN EVER PLAYED
--
-- WHAT THIS IS NOT
--
-- It is not a correctness fix, and that matters, because I went looking for
-- one and did not find it. Recording what I checked so the next agent does not
-- re-open it:
--
--   * The "3-hour sweep cliff" is not real. fn_spin_sweep_unbooked defaults to
--     p_lookback_mins 180, but /api/cron/spin-sweep passes it explicitly -
--     LOOKBACK_MINS = 14 * 24 * 60 - so 180 never applies in production. The
--     default is dead of its own accord; changing it would have shipped a
--     no-op that read like a fix.
--   * The 112 Deep Stack Society Spins of 2026-08-31 that booked sixteen hours
--     late are already explained and already fixed: the sweep was dying on
--     57014 statement timeouts until migration 20260901130329 capped the pass
--     at p_limit 25, and the backlog drained at 15:30-16:30 that same day.
--   * booking_gaps guarding on `d.drawn is not null` is not a blind spot.
--     It asks "did a BOOKED spin pay more than it drew". The other question -
--     "was it booked at all" - is already answered separately by the
--     `unbooked_spins` gauge in fn_spin_metrics. Two questions, two numbers.
--
-- Measured live before writing this: zero spins unbooked at any age, and every
-- jackpot_draw row in the last eight hours booked in-line, worst lag 0 minutes.
-- Nothing is broken. Do not repair it.
--
-- WHAT IS ACTUALLY WRONG
--
-- The scan is expensive, and two hot paths pay for it every time.
--
-- `idx_tournaments_variant` indexes variant alone, which is not selective
-- here: it hands back all ~41k spin rows and the filter then throws 37,986 of
-- them away. Measured on production:
--
--   fn_spin_metrics `ub` CTE (24h bound)      877 ms   -- every /metrics scrape
--   fn_spin_sweep_unbooked scan (unbounded)  1244 ms   -- every 15 minutes
--
-- The sweep runs as service_role under an eight-second statement_timeout, and
-- migration 20260901130329 sized p_limit=25 around exactly this: "a settle
-- costs ~60ms and the scan ahead of it 1.2s". That 1.2s is this scan. It is a
-- sequential scan reading 96,431 buffers to return nothing at all.
--
-- So this index buys two things: a metrics endpoint that is not spending most
-- of a second on one CTE, and about 1.2 seconds of headroom returned to the
-- sweep's eight-second budget - which is the budget that already failed once.
--
-- The predicate is immutable (no now()), so it is legal in a partial index.
-- started_at ascending because every consumer wants oldest-first: the sweep
-- orders by it so a backlog drains deterministically.
--
-- HORSES: nothing here reads is_horse. A spin is scanned, swept and counted
-- identically whoever sat in it (CLAUDE.md 10.5).
--
-- ROLLBACK
--   drop index if exists public.idx_tournaments_spin_unbooked_scan;

begin;

create index if not exists idx_tournaments_spin_unbooked_scan
  on public.tournaments (started_at)
  where variant = 'spin' and status in ('RUNNING', 'COMPLETED');

comment on index public.idx_tournaments_spin_unbooked_scan is
  'Serves the unbooked-spin anti-join in fn_spin_metrics and '
  'fn_spin_sweep_unbooked. Before it, both did a full read of every spin ever '
  'played (877ms and 1244ms measured). Ascending: the sweep drains oldest-first.';

-- Assert the index exists and is the shape claimed, so a wrong assumption
-- aborts here rather than shipping quietly as a no-op.
DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_tournaments_spin_unbooked_scan';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'idx_tournaments_spin_unbooked_scan was not created';
  END IF;
  IF v_def NOT LIKE '%started_at%' THEN
    RAISE EXCEPTION 'index is not on started_at: %', v_def;
  END IF;
  IF v_def NOT LIKE '%RUNNING%' OR v_def NOT LIKE '%COMPLETED%' THEN
    RAISE EXCEPTION 'index predicate lost its status filter: %', v_def;
  END IF;
  RAISE NOTICE 'idx_tournaments_spin_unbooked_scan in place: %', v_def;
END $$;

commit;
