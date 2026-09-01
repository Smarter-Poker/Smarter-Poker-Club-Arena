-- The payout sweep's row limits stopped covering their own windows.
--
-- fn_tournament_payout_sweep limits the SCAN, so a limit below the window's
-- population silently shrinks the window back down - and it orders
-- newest-first, so what falls off the end is the oldest, which is precisely
-- what a deep pass exists to reach.
--
-- Measured 2026-09-01 against production:
--
--   window   population   limit    covered
--   2 days        7,020    6,000   no  (engine, already raised to 20,000 in
--                                       merged code awaiting the 15:00 deploy)
--   7 days       30,878   40,000   yes (cron ca-payout-sweep-hourly)
--   30 days      48,093   40,000   NO  (cron tourney_payout_sweep_detect_daily,
--                                       and the engine's deep pass)
--
-- The 30-day figure was 35,220 when 40,000 was chosen on 2026-08-27. Daily
-- volume has grown since, so both 30-day callers now stop 8,093 short.
--
-- Nothing has been missed in practice, and it is worth being precise about
-- why rather than claiming more than the evidence supports: the hourly 7-day
-- pass is APPLYING and fully covers its window, so every event is reconciled
-- repeatedly while it is fresh. The tail the 30-day passes cannot reach has
-- already been swept many times before it ages that far. The hole is in the
-- guarantee, not yet in the money.
--
-- Both cron limits go to 150,000, ~3x the current population, the multiple the
-- engine's other two limits use. The engine constant is raised in the same
-- change (RakebackSettlerService.PAYOUT_SWEEP_DEEP_LIMIT).

DO $$
DECLARE r record; v_new text; v_n int := 0;
BEGIN
  FOR r IN SELECT jobid, jobname, command FROM cron.job
            WHERE command LIKE '%fn_tournament_payout_sweep%'
  LOOP
    v_new := replace(r.command, ', 40000)', ', 150000)');
    IF v_new <> r.command THEN
      PERFORM cron.alter_job(r.jobid, command => v_new);
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'no payout-sweep cron job carried the 40000 limit - re-measure before assuming';
  END IF;
END $$;

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM cron.job
   WHERE command LIKE '%fn_tournament_payout_sweep%' AND command LIKE '%40000%';
  IF v_left > 0 THEN
    RAISE EXCEPTION '% payout-sweep cron job(s) still limited to 40000', v_left;
  END IF;
END $$;
