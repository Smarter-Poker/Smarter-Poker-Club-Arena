-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4.2, THIRD CUT - THE OPENING BALANCES ARE READ AT THEIR OWN INSTANT
-- (chip standard, 2026-09-04 21:40 UTC). The first scheduled meter run
-- (21:38) read Deep Stack Society's pool at -0.13 / -0.06 / -0.06: exactly
-- one 0.25 drop. The opening balances written by 20260904211714 carry
-- taken_at = the migration transaction's now() (its start) while their bank
-- figures were read a few hundred milliseconds later; a drop whose
-- transaction began after that now() and committed before the read was in
-- the opening figure AND in the first interval's journal. A one-off offset,
-- not a leak, and inside tolerance - but the meter's first hour must read
-- zero, so the opening balance is corrected by that drop, in the open, with
-- the reason on the row, and the first snapshot re-derived from the corrected
-- opening. fn_bbj_open_pool_baseline (20260904213506) already reads banks and
-- journal in one statement, so no later baseline can carry this.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE b public.ca_bbj_pool_snapshots%ROWTYPE; s public.ca_bbj_pool_snapshots%ROWTYPE; v_n int := 0;
BEGIN
  FOR b IN SELECT * FROM public.ca_bbj_pool_snapshots WHERE is_baseline AND note LIKE 'OPENING BALANCE, not a movement%' LOOP
    SELECT * INTO s FROM public.ca_bbj_pool_snapshots WHERE prev_id = b.id ORDER BY taken_at LIMIT 1;
    CONTINUE WHEN s.id IS NULL OR (s.unexplained_main = 0 AND s.unexplained_backup = 0 AND s.unexplained_promo = 0);
    IF abs(s.unexplained_main) + abs(s.unexplained_backup) + abs(s.unexplained_promo) > 1.00 THEN
      RAISE EXCEPTION 'pool % first interval off by more than a drop (% % %): not a baseline artifact', b.pool_id, s.unexplained_main, s.unexplained_backup, s.unexplained_promo;
    END IF;
    UPDATE public.ca_bbj_pool_snapshots
       SET main = main + s.unexplained_main, backup = backup + s.unexplained_backup, promo = promo + s.unexplained_promo,
           note = note || format(' CORRECTED 2026-09-04 21:40 UTC by %s / %s / %s (main / backup / promo): one drop straddled the opening read, see 20260904 third cut.', s.unexplained_main, s.unexplained_backup, s.unexplained_promo)
     WHERE id = b.id;
    UPDATE public.ca_bbj_pool_snapshots
       SET unexplained_main = 0, unexplained_backup = 0, unexplained_promo = 0
     WHERE id = s.id;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one baseline to correct (Deep Stack Society, -0.25), found %', v_n;
  END IF;
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration phase_4_2_the_opening_balances_are_read_at_their_own_instant',
         root_cause = 'the opening balance row carried the migration transaction start as taken_at while its bank figures were read later; one 0.25 drop straddled and was counted in both the opening and the first interval',
         resolution = 'opening balance corrected by the straddled drop with the reason on the row; first snapshot re-derived to 0; later baselines are read in one statement (20260904213506)'
   WHERE dedupe_key = 'bbj-meter:a7a65cfc-64e8-4134-afe5-68d3c1a86348:2026-09-04-21' AND status = 'open';
END $$;
