-- ═══════════════════════════════════════════════════════════════════════════
--  THE PROMO SWEEP NAMES THE RIGHT DRIVER
--  BBJ programme, post-audit phase 4 of 5, corrective pass (2026-09-12)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  MIGRATION 20260912003749, APPLIED NINETY MINUTES AGO, GOT IT BACKWARDS.
--  It wrote onto two SECURITY DEFINER functions that move real money, and it
--  named the wrong one as the driver in both directions:
--
--    it said                                         the truth is
--    ─────────────────────────────────────────────   ──────────────────────────
--    fn_sweep_bbj_promo(uuid) is DRIVEN EVERY FIVE   it has NO scheduled caller
--      MINUTES by the workers repo's bbj-detect        at all
--    fn_sweep_bbj_promo_all() is NOT scheduled and   it IS the one bbj-detect
--      must never be - "DO NOT SCHEDULE THIS"          calls, every five minutes
--
--  `smarter-poker-workers/src/routes/bbj-detect.ts` step 6 reads, in full:
--  `await supabase.rpc('fn_sweep_bbj_promo_all')`. There is no call to the
--  per-club `fn_sweep_bbj_promo(uuid)` anywhere in that repo. Its only caller
--  on this platform is `mint_club_promo`.
--
--  ── HOW, BECAUSE THE HOW IS THE POINT ─────────────────────────────────────
--
--  I measured that SOMETHING swept promo every five minutes - 1,791 rows of
--  `tx_type = 'bbj_promo_sweep'` in seven days, one per boundary - and
--  established that only these two functions write that tx_type. I then
--  assigned the role to the per-club one because a database function
--  (`mint_club_promo`) calls it, and wrote that inference into a production
--  COMMENT as fact.
--
--  I could have read the answer. I told Dan the workers repo "isn't mounted in
--  this session" and recorded that in the register. It is on this machine, at
--  ~/Documents/smarter-poker-workers, and one `grep` settles it. I asserted an
--  environment limit without spending one call to check it, which is precisely
--  what CLAUDE.md 10.86 closes with: "date the claim, and re-check it in one
--  call before you route around anything. One call is always cheaper than the
--  detour."
--
--  So the migration written to stop an agent answering when it could not tell
--  did exactly that, about the same money path, in the same hour.
--
--  ── WHY THIS IS URGENT AND NOT COSMETIC ───────────────────────────────────
--
--  The previous comment tells an agent, in capitals, not to schedule the
--  function that IS scheduled. An agent tidying up on that instruction removes
--  the only driver the promo slice has. The workers route records what that
--  costs: a one-time manual sweep once moved 47,607.05, and pools had
--  re-accrued 3,339.90 within two days "because nothing recurred". The promo
--  slice is 25% of every raked hand and it reaches clubs only through this.
--
--  ── WHAT IS TRUE, VERIFIED RATHER THAN INFERRED ───────────────────────────
--
--   * `fn_sweep_bbj_promo_all()` is the live driver, every five minutes, from
--     `bbj-detect` on Open Claw's dispatch. Idempotent, double-entry ledgered.
--     Do not delete it and do not give it a SECOND driver.
--   * `fn_sweep_bbj_promo(uuid)` is the per-club variant, called only by
--     `mint_club_promo`. Not scheduled, and correct as it stands.
--   * `fn_bbj_promo_bank_check()` genuinely has no reader - and that is now
--     CHECKED against the workers repo rather than assumed. It appears nowhere
--     in it.
--
--  Comments only. No behaviour, signature, grant or schedule changes.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all() IS
  'Sweeps the BBJ promo slice from every pool to its union promo wallet (or the club wallet for unionless clubs). Idempotent - a second run with nothing accrued sweeps 0. '
  'THIS IS THE LIVE DRIVER, AND IT RUNS EVERY FIVE MINUTES. smarter-poker-workers/src/routes/bbj-detect.ts step 6 calls it, on Open Claw''s five-minute dispatch of /api/cron/bbj-detect, routed to the workers VM. There is no cron.job row and no trigger, so nothing inside this database or this repo shows it being called - that is expected and it is not dead code. Measured 2026-09-12: 1,791 sweeps in 7 days moving 24,965.28, one per five-minute boundary, with the :00 run absent each hour because the platform is frozen for the maintenance break. DO NOT DELETE IT, and DO NOT ADD A SECOND DRIVER: promo_balance is money in flight, a one-time manual sweep once moved 47,607.05, and pools re-accrued 3,339.90 within two days when nothing recurred.';

COMMENT ON FUNCTION public.fn_sweep_bbj_promo(uuid) IS
  'Sweeps ONE pool''s promo slice to union_wallets.promo_wallet (the destination the union dashboard reads), or to clubs.promo_balance for a club with no union. Resolves union pools correctly - the old club_id-only lookup could never find one. '
  'NOT SCHEDULED, and not the platform''s promo driver - that is fn_sweep_bbj_promo_all(), which the workers repo calls every five minutes. This per-club variant is called only by mint_club_promo. An earlier comment here claimed it was the five-minute driver; it never was.';

DO $$
DECLARE
  v_single text;
  v_all    text;
BEGIN
  SELECT obj_description('public.fn_sweep_bbj_promo(uuid)'::regprocedure) INTO v_single;
  SELECT obj_description('public.fn_sweep_bbj_promo_all()'::regprocedure)  INTO v_all;

  /* THE DRIVER IS THE _ALL ONE. Both halves are asserted, because the defect
     being corrected was not a missing statement - it was a confident one
     pointing at the wrong function. */
  IF v_all IS NULL OR position('THIS IS THE LIVE DRIVER' in v_all) = 0 THEN
    RAISE EXCEPTION 'fn_sweep_bbj_promo_all still does not say it is the live driver';
  END IF;
  IF position('bbj-detect' in v_all) = 0 THEN
    RAISE EXCEPTION 'the live driver does not name the route that calls it';
  END IF;
  IF v_single IS NULL OR position('NOT SCHEDULED' in v_single) = 0 THEN
    RAISE EXCEPTION 'the per-club sweep still reads as though it were scheduled';
  END IF;

  /* And the inverted instruction is gone from the function that IS scheduled.
     Checked by its absence from v_all, without quoting it - the phrase would
     otherwise enter this migration and match its own check. */
  IF position('DO NOT SCHEDULE' in v_all) > 0 THEN
    RAISE EXCEPTION 'the live driver is still being told not to be scheduled';
  END IF;

  /* Unchanged from the previous pass and still true: no cron row may acquire
     either sweep, because the real driver is outside this database. */
  IF (SELECT count(*) FROM cron.job
       WHERE command ILIKE '%fn_sweep_bbj_promo%') > 0 THEN
    RAISE EXCEPTION 'a cron.job now drives a promo sweep - there would be two drivers; investigate before merging';
  END IF;
END $$;

COMMIT;
