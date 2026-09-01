-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831104428; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING ON THE TWO DOUBLE-PAYMENT BACKLOGS (2026-08-31)
--
-- Both alerts were filed with decision_owner "Dan" precisely because
-- reversing credits players have already been shown is not an agent's call:
--
--   tournament_double_payment_backlog  18,201.60  Sunday $200 Deep Stack paid
--     62,841.60 against a 44,640 pool after an outage reset replayed an
--     already-paid event.
--   mystery_bounty_double_pay_backlog     156.40  chests swept with a reveal
--     in flight, paid again under a different idempotency key.
--
-- Dan, verbatim: "IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE
-- BETA TESTING, AS LONG AS THE LEAK OR BUG IS FIXED".
--
-- So: NO CLAWBACK, and the two are closed as decided rather than left open as
-- undecided. The amounts and their causes stay on the resolved rows and in
-- tournament_conservation_baseline forever — this records a decision, it does
-- not erase a number.
--
-- Both underlying defects are fixed and guarded:
--   * the reset-replay hole is now visible to fn_tournament_prize_disbursement_audit,
--     which reads the wallet ledger instead of tournament_players.prize (the
--     column the reset overwrites, and the reason every check stayed green);
--   * the mystery-bounty double pay was fixed by
--     20260830034500_a_chest_with_a_reveal_in_flight_is_not_unclaimed.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'decision', 'NO CLAWBACK — Dan, 2026-08-31, verbatim: "IM NOT WORRIED ABOUT ANY DOUBLE PAYMENTS OR ACCURACY WE ARE BETA TESTING, AS LONG AS THE LEAK OR BUG IS FIXED". Closed as decided, not as unnoticed; the amount and cause remain on this row.',
         'decided_at', now())
 WHERE resolved IS NOT TRUE
   AND source IN ('tournament_double_payment_backlog', 'mystery_bounty_double_pay_backlog');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.financial_alerts
   WHERE resolved IS NOT TRUE
     AND source IN ('tournament_double_payment_backlog','mystery_bounty_double_pay_backlog');
  IF n <> 0 THEN RAISE EXCEPTION '% double-payment backlog alert(s) still open', n; END IF;
  -- The record must survive the decision.
  IF NOT EXISTS (SELECT 1 FROM public.tournament_conservation_baseline
                  WHERE tournament_id = 'dfae9288-40e2-485d-8c97-a13dd53ab483') THEN
    RAISE EXCEPTION 'the 18,201.60 acknowledgment was lost';
  END IF;
END $$;

