-- the_cashier_conservation_report_is_caller_driven
--
-- fn_ca_orphaned_checks_watch warned at 06:18 UTC on 2026-10-12 that one check
-- function is run by nothing: fn_cashier_conservation_report(p_club_id), added
-- by 20261011162855_cashier_club_baseline_conservation_report. It is not a
-- sweep. It is the reader behind the cashier's Conservation Report
-- (src/services/CashierConservation.ts), granted to authenticated callers and
-- answering for the one club its operator asked about. A schedule has no club
-- to pass. Recorded with its reason, as the watch asks.
BEGIN;
INSERT INTO public.ca_check_sweep_exemptions (proname, reason, added_at)
VALUES
  ('fn_cashier_conservation_report',
   'The reader behind the cashier Conservation Report (src/services/CashierConservation.ts): an operator asks it about one club (p_club_id). Nothing to schedule: it answers a question an operator asked.',
   now())
ON CONFLICT DO NOTHING;
DO $prove$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ca_orphaned_checks()) THEN
    RAISE EXCEPTION 'ORPHANED_CHECKS_REMAIN';
  END IF;
END
$prove$;
COMMIT;
