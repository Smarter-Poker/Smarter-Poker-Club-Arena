-- THE BASELINE, MEASURED PROPERLY THIS TIME (2026-08-25)
--
-- The previous rebaseline set 2,240.55, read moments after the 56,938.27
-- restoration landed. Within the hour the check read 2,572.59 and went
-- unhealthy, which looked like a live leak of roughly 330 an hour.
--
-- It is not. Measured twice, 74 seconds apart, with the platform dealing:
--
--   22:21:58  gap 2572.59  contributions 337,666.61  balances 88,181.40
--   22:23:12  gap 2572.59  contributions 337,675.14  balances 88,189.93
--
-- Contributions and balances both rose by exactly 8.53 and the gap did not move
-- at all. Conservation is holding in real time; only the recorded baseline was
-- wrong, because it was taken while the restoration was still settling.
--
-- Two things were disproven on the way here, written down so nobody re-derives
-- them:
--
--   * There is NO contributions-checkpoint lag. fn_bbj_contributions_total is
--     checkpoint + tail-after-as_of, and the checkpoint is exact: 677,578 rows
--     / 337,293.95 against an actual 677,578 / 337,293.95 for created_at <
--     as_of, with zero null created_at. The 332.04 "lag" reported earlier was
--     an artifact of reading the checkpoint and the raw sum in ONE query while
--     rows arrived between the two subqueries.
--
--   * The promo over-sweep is HISTORICAL, not ongoing - see
--     fn_bbj_promo_bank_check and the note in its migration.
--
-- So the standing gap is ~2,470.49 of historical promo over-sweep plus ~102 of
-- other historical residue, and it is FLAT. Tolerance stays 1.00, so any real
-- movement from here goes red immediately.
--
-- ROLLBACK: UPDATE bbj_conservation_baseline SET baseline_gap = 2240.55 WHERE id = 1;

DO $$
DECLARE
  v_a numeric;
  v_b numeric;
BEGIN
  v_a := ((public.fn_bbj_conservation_check()) ->> 'gap')::numeric;
  PERFORM pg_sleep(2);
  v_b := ((public.fn_bbj_conservation_check()) ->> 'gap')::numeric;

  -- Only baseline a gap that is actually standing still. If it moves between
  -- two reads seconds apart, something IS leaking, and freezing a baseline over
  -- it would hide the exact thing this check exists to catch.
  IF abs(v_b - v_a) > 0.01 THEN
    RAISE EXCEPTION 'refusing to baseline a moving gap: % then %', v_a, v_b;
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET baseline_gap = v_b,
         measured_at  = now(),
         note         = 'Measured 2026-08-25 as a STABLE gap (two reads 2s apart agreed) after the 56,938.27 erased residual was restored. Composition: ~2,470.49 historical promo over-sweep (see fn_bbj_promo_bank_check, confirmed flat) plus ~102 other historical residue. No checkpoint lag exists - fn_bbj_contributions_total is exact. Tolerance stays 1.00 so any real movement goes red at once.'
   WHERE id = 1;

  RAISE NOTICE 'bbj baseline set to stable %', v_b;
END $$;
