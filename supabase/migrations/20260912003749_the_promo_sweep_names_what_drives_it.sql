-- ═══════════════════════════════════════════════════════════════════════════
--  THE PROMO SWEEP NAMES WHAT DRIVES IT
--  BBJ programme, post-audit phase 4 of 5 (2026-09-12)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  The phase 2 sweep left this open: "`fn_sweep_bbj_promo` moves money
--  continuously with no cron row in this repo and no entry in
--  `docs/BAND-AIDS-REGISTER.md`."
--
--  IT IS WORSE THAN THAT, AND ALSO BETTER. Measured on production today:
--
--    * The sweep IS running, every five minutes, exactly on the boundary
--      (:00 :05 :10 ...), with the :00 run missing each hour because the
--      platform is frozen for the maintenance break. 1,791 sweeps in seven
--      days moving 24,965.28 chips; the most recent 0.13 at 00:20:01 UTC.
--      It is not dead code and must not be deleted.
--
--    * NOTHING IN EITHER REPO CALLS IT. No `cron.job` row names it (the four
--      BBJ cron jobs are rollup-catchup, repair-unbanked, threshold-notify and
--      the invariant audit). No trigger has it as `tgfoid`. No TypeScript in
--      Club Arena or the World Hub references it. The driver is a THIRD repo:
--      Open Claw dispatches `/api/cron/bbj-detect` on `*/5`, and
--      `scripts/openclaw-cron-dispatcher.py` line 1022 records that the route
--      now lives in the workers repo as `src/routes/bbj-detect`.
--
--  So an agent auditing Club Arena reads a SECURITY DEFINER function that
--  moves real money, finds no caller and no schedule anywhere it can see, and
--  reasonably concludes it is dead. I concluded exactly that this morning,
--  from `promo_balance = 0.00` on every pool, and was wrong: the zero is the
--  sweep working, not the slice being banked inline.
--  `bbj_record_contribution` accrues `promo_balance = promo_balance + v_promo`
--  on every one of 46,814 contributions a day, and the sweep empties it.
--
--  ── THE TRAP THIS CLOSES ──────────────────────────────────────────────────
--
--  `fn_sweep_bbj_promo_all`'s COMMENT currently ends with the words
--  "Schedule this". It is not scheduled, and its per-club sibling already is,
--  from another repo. An agent who obeys that sentence adds a SECOND driver
--  onto the same staging slot: `_all` loops every pool with `FOR UPDATE`
--  while `fn_sweep_bbj_promo` is doing the same pool five minutes apart, and
--  the promo slice of every raked hand on the platform is what they are
--  racing over. A comment that recruits the next agent into a money path is
--  not documentation, it is a defect with good manners.
--
--  The comments are the fix, because the comments are what is wrong. The
--  functions themselves are correct and stay exactly as they are: no
--  behaviour, no signature, no grant changes here.
--
--  ── WHY NO NEW CRON IS ADDED ──────────────────────────────────────────────
--
--  CLAUDE.md 10.12 forbids shipping a scheduled job as the answer to a
--  defect, and 10.85 puts scheduled application work in Open Claw rather than
--  anywhere an agent finds convenient. The sweep already has a driver and it
--  already works; the defect was that this repo could not see it. Naming it
--  is the whole fix. Nothing here schedules, repairs, backfills or sweeps.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

/* NAMES ITS DRIVER, so the next reader does not have to rediscover it from
   union_wallet_transactions timestamps the way this migration did. */
COMMENT ON FUNCTION public.fn_sweep_bbj_promo(uuid) IS
  'Sweeps a pool promo slice to union_wallets.promo_wallet (the destination the union dashboard reads), or to clubs.promo_balance for a club with no union. Resolves union pools correctly - the old club_id-only lookup could never find one. '
  'DRIVEN EVERY FIVE MINUTES, FROM OUTSIDE THIS DATABASE AND OUTSIDE THIS REPO: Open Claw dispatches /api/cron/bbj-detect on */5, and that route lives in the workers repo (src/routes/bbj-detect), not in Club Arena and not in the World Hub. There is no cron.job row and no trigger - do not add either, and do not delete this function as dead code. Measured 2026-09-12: 1,791 sweeps in 7 days moving 24,965.28, one per five-minute boundary, with the :00 run absent each hour because the platform is frozen for the maintenance break.';

/* THE "SCHEDULE THIS" SENTENCE IS THE DEFECT. Replaced with the reason not to. */
COMMENT ON FUNCTION public.fn_sweep_bbj_promo_all() IS
  'Sweeps the BBJ promo slice from every pool to its union promo wallet (or the club wallet for unionless clubs). Idempotent - a second run with nothing accrued sweeps 0. '
  'DO NOT SCHEDULE THIS. Its previous comment ended by instructing the next agent to schedule it, which is why this one says the opposite first. It is not scheduled, and its per-club sibling fn_sweep_bbj_promo already is, every five minutes, from the workers repo via Open Claw /api/cron/bbj-detect. A second driver on the same staging slot would have this function looping every pool FOR UPDATE against the live one on the same rows, and the thing they would be racing over is the promo slice of every raked hand on the platform. Kept as the operator-run catch-up for a pool the per-club path could not reach - run it by hand, read the jsonb it returns, and say why in the changelog.';

/* A CHECK NOBODY CAN SEE IS NOT A CHECK (CLAUDE.md 10.83). This one has no
   cron row, no caller and - until now - no comment at all, so nothing said
   whether it was load-bearing or abandoned. It is a READ: it computes, it
   does not move money, and it is safe to run by hand at any time. */
COMMENT ON FUNCTION public.fn_bbj_promo_bank_check() IS
  'Reads whether the promo slice that left bbj_pools.promo_balance actually arrived in the union or club promo wallet. A read - it moves nothing and repairs nothing. NOT SCHEDULED and it has no automatic reader: as of 2026-09-12 nothing in cron.job, in either repo, or in the workers repo calls it, so it answers only when a person asks. That is a deliberate state and not an oversight - see docs/BAND-AIDS-REGISTER.md - but it does mean a stalled promo sweep would not raise anything on its own; the visible symptom would be bbj_pools.promo_balance climbing instead of sitting near zero.';

DO $$
DECLARE
  v_single text;
  v_all    text;
  v_check  text;
BEGIN
  SELECT obj_description('public.fn_sweep_bbj_promo(uuid)'::regprocedure) INTO v_single;
  SELECT obj_description('public.fn_sweep_bbj_promo_all()'::regprocedure)  INTO v_all;
  SELECT obj_description('public.fn_bbj_promo_bank_check()'::regprocedure) INTO v_check;

  IF v_single IS NULL OR position('bbj-detect' in v_single) = 0 THEN
    RAISE EXCEPTION 'the live promo sweep still does not name what drives it';
  END IF;

  /* The refusal must be present. Checked as text because the text IS the
     defect being fixed.

     THIS ASSERTION DELIBERATELY DOES NOT QUOTE THE OLD SENTENCE. Writing
     `position('<the recruiting sentence>' in v_all) > 0` would put that exact
     string into this migration, and the phase 2 corrective pass hit this trap
     four times: a migration that asserts the absence of a phrase, and quotes
     the phrase in order to do so, matches its own check. The refusal reading
     true is sufficient - the two cannot both be present, because this
     migration writes the whole comment in one statement. */
  IF v_all IS NULL OR position('DO NOT SCHEDULE THIS' in v_all) = 0 THEN
    RAISE EXCEPTION 'fn_sweep_bbj_promo_all does not refuse to be scheduled';
  END IF;

  IF v_check IS NULL OR position('NOT SCHEDULED' in v_check) = 0 THEN
    RAISE EXCEPTION 'the promo bank check still does not say it has no reader';
  END IF;

  /* And neither sweep acquired a scheduler while this migration was being
     written. If one has, the two-driver race this migration exists to prevent
     is already live and somebody has to look at it rather than merge past it. */
  IF (SELECT count(*) FROM cron.job
       WHERE command ILIKE '%fn_sweep_bbj_promo%') > 0 THEN
    RAISE EXCEPTION 'a cron.job now drives a promo sweep - there would be two drivers; investigate before merging';
  END IF;
END $$;

COMMIT;
