-- ═══════════════════════════════════════════════════════════════════════════
--  THE WHEEL IS LATE, AND NOTHING WAS MEASURING IT
--  2026-08-31, spins audit part 2
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's rule for a Spin is a number: "THE MOMENT THE 3RD SEAT IS BOUGHT AND
-- PAID FOR THE SPIN ANIMATION MUST START 1 SECOND LATER."
--
-- The engine already computes exactly how far behind that it went out —
-- `spinRevealLagMs`, from the third buy-in debit to the broadcast. It logged
-- it to the console and sent it to the client, and persisted it NOWHERE. So
-- the only way to answer "is the wheel still opening on time?" was for an
-- agent to reconstruct it by hand out of table_seats and spin_reserve_ledger,
-- which is how round 18's measured 3.0s p50 drifted to 13.7s over a single day
-- with nothing on the platform noticing.
--
-- A number a rule is written in terms of, that nobody stores, is a rule
-- nothing can enforce. This stores it.
--
-- WHY THE COLUMN AND NOT A NEW TABLE. It is exactly one integer per spin, with
-- the same lifetime as the row that already carries the multiplier, the prize
-- pool and the blind structure — and the engine writes all of those in one
-- retried, self-healing UPDATE. Riding that write costs no extra round trip in
-- the hot start path, which is the path being measured.
--
-- APPLIED to production 2026-08-31 as migration 20260831153436.
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS spin_reveal_lag_ms integer;

COMMENT ON COLUMN public.tournaments.spin_reveal_lag_ms IS
  'Milliseconds from the third paid seat to the spin reveal broadcast. Written by TournamentManagerBase on the same UPDATE that carries the draw. NULL on a spin that started before 2026-08-31, or one whose draw row write failed.';

-- Percentiles are computed over a window, so the index is on the window
-- column with the metric carried along; partial, so it only covers spins.
CREATE INDEX IF NOT EXISTS idx_tournaments_spin_reveal_lag
  ON public.tournaments (started_at DESC)
  INCLUDE (spin_reveal_lag_ms)
  WHERE spin_reveal_lag_ms IS NOT NULL;

/* THE STANDING MEASUREMENT.
   Round 18 shipped p50 3.02s / p90 4.70s and recorded it in a changelog. A
   number in a changelog cannot regress loudly, and this one regressed to
   13.7s within a day. `breach` is keyed to 5s at p50, which is comfortably
   above the shipped figure and well below anything a player would call
   "as soon as possible". */
CREATE OR REPLACE VIEW public.v_spin_reveal_latency AS
SELECT date_trunc('hour', t.started_at)                                    AS hour,
       count(*)                                                            AS spins,
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY t.spin_reveal_lag_ms)::numeric) AS p50_ms,
       round(percentile_cont(0.9)  WITHIN GROUP (ORDER BY t.spin_reveal_lag_ms)::numeric) AS p90_ms,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY t.spin_reveal_lag_ms)::numeric) AS p99_ms,
       max(t.spin_reveal_lag_ms)                                           AS worst_ms,
       count(*) FILTER (WHERE t.spin_reveal_lag_ms > 1000)                 AS past_the_lead_in,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY t.spin_reveal_lag_ms) > 5000) AS breach
  FROM public.tournaments t
 WHERE t.variant = 'spin'
   AND t.spin_reveal_lag_ms IS NOT NULL
   AND t.started_at > now() - interval '7 days'
 GROUP BY 1;

REVOKE ALL ON public.v_spin_reveal_latency FROM PUBLIC;
REVOKE ALL ON public.v_spin_reveal_latency FROM anon, authenticated;
GRANT SELECT ON public.v_spin_reveal_latency TO service_role;

COMMENT ON VIEW public.v_spin_reveal_latency IS
  'Hourly percentiles of the gap between the third paid seat and the spin wheel going out. Round 18 shipped p50 3.02s / p90 4.70s; breach flags an hour whose p50 passed 5s. past_the_lead_in counts the spins that missed Dan''s "1 second later" outright.';

DO $$
DECLARE n integer;
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tournaments' AND column_name='spin_reveal_lag_ms';
  IF NOT FOUND THEN RAISE EXCEPTION 'spin_reveal_lag_ms column missing'; END IF;

  PERFORM 1 FROM pg_views WHERE schemaname='public' AND viewname='v_spin_reveal_latency';
  IF NOT FOUND THEN RAISE EXCEPTION 'v_spin_reveal_latency missing'; END IF;

  -- The view must be readable and must not throw on an empty metric column.
  SELECT count(*) INTO n FROM public.v_spin_reveal_latency;
  RAISE NOTICE 'v_spin_reveal_latency rows at apply time: %', n;
END $$;
