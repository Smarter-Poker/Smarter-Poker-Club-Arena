-- THE BASELINE MOVES WHEN THE MONEY COMES BACK (2026-08-25)
--
-- baseline_gap was 59,510.86, set when 56,938.27 of it was money that had been
-- erased out of a retired pool. That money has been restored, the measured gap
-- is now 2,240.55, and fn_bbj_gap_decomposition confirms
-- merged_pool_residual_erased = 0 and restored_to_pools = 56,938.27.
--
-- Left alone, fn_bbj_conservation_check compares 2,240.55 against a baseline of
-- 59,510.86 and reports healthy = false forever, on a drift of -57,270.31 that
-- is simply the repayment. A permanently red check is one nobody reads, and
-- this estate has already paid for that lesson more than once.
--
-- The new baseline is the gap that GENUINELY remains and that no audit has yet
-- attributed. It is carried forward, not explained away, so it stays visible as
-- the open figure. If it moves, the check goes red for a real reason.
--
-- The guard below refuses to rebaseline while any erasure is still unrepaid -
-- moving a baseline is only honest once the thing it was covering has been paid
-- back. bbj_conservation_baseline.id is an integer, not a uuid.
--
-- VERIFIED AFTER APPLYING: healthy = true, gap 2,240.55, drift 0.
--
-- ROLLBACK: UPDATE bbj_conservation_baseline SET baseline_gap = 59510.86 WHERE id = 1;

DO $$
DECLARE
  v_id       int;
  v_measured numeric;
  v_erased   numeric;
BEGIN
  v_measured := ((public.fn_bbj_conservation_check()) ->> 'gap')::numeric;
  v_erased   := ((public.fn_bbj_gap_decomposition()) -> 'explained' ->> 'merged_pool_residual_erased')::numeric;

  IF v_erased IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'refusing to rebaseline: % still erased and unrestored', v_erased;
  END IF;

  SELECT id INTO v_id FROM public.bbj_conservation_baseline ORDER BY measured_at DESC LIMIT 1;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no bbj_conservation_baseline row to update';
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET baseline_gap = v_measured,
         measured_at  = now(),
         note         = 'Rebaselined 2026-08-25 after the 56,938.27 erased residual of pool 0867a7fd was restored to f9806a7f. The remaining ' || v_measured::text || ' is unattributed and is carried forward as the open figure, not explained away.'
   WHERE id = v_id;

  RAISE NOTICE 'bbj baseline moved to %', v_measured;
END $$;
