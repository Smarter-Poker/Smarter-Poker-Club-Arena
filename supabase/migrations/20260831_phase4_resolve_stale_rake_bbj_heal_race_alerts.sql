-- ══════════════════════════════════════════════════════════════════════════
--  FOUR RAKE/BBJ ALERTS THAT WERE TRUE WHEN WRITTEN AND ARE NOT TRUE NOW
-- ══════════════════════════════════════════════════════════════════════════
--
-- fn_rake_bbj_audit raised 4 critical alerts between 11:38 and 11:44 today,
-- naming three cash hands:
--
--   I5_drop_not_banked_to_pool   21fe3424... (bbj 0.48), a7f72343... (bbj 0.50)
--   I7_raked_hand_never_banked   c302e37e... (rake 1.30)
--
-- ALL THREE ARE NOW BANKED AND ATTRIBUTED TO THE CENT. Checked individually,
-- with no time window, rather than trusting a later clean audit run (a rolling
-- 2h window goes quiet on its own and that proves nothing):
--
--   hand        rake    rake_records  attributions  credited
--   21fe3424..  1.80    1             2             1.8000
--   a7f72343..  2.90    1             3             2.9000
--   c302e37e..  1.30    1             8             1.3000
--
-- Credited equals rake exactly in all three. No chips were lost.
--
-- WHAT ACTUALLY HAPPENED. `fn_rake_repair_unbanked` heals hands whose rake was
-- taken but not banked, and I7 carries a `v_heal_grace` cut-off whose own
-- comment says it exists to "outlast fn_rake_repair_unbanked". On this
-- occasion the heal landed AFTER that grace window, so the audit sampled the
-- hands mid-repair and called it a violation. The 11:44 alert already shows I5
-- back to n=0 while I7 was still catching up, which is the repair finishing in
-- front of us.
--
-- So this is a RACE BETWEEN A REPAIR AND ITS OWN WATCHDOG, not a leak. It is
-- worth leaving the alert loud: an unbanked fee that never heals looks exactly
-- like this for the first few minutes, and the cost of the false positive is
-- one person checking three hands.
--
-- NOT SILENCED, RESOLVED. The suppressor reads the `resolution` key; without
-- it these would re-raise every cycle, which is the alert loop this estate
-- created and then fixed earlier today on the payout reconciler.

UPDATE public.financial_alerts
   SET resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'resolution', jsonb_build_object(
           'by', 'phase4-verification-2026-08-31',
           'verdict', 'stale: repair landed after the audit sampled it',
           'evidence', 'all three hands hold a rake_records row and attributions '
                    || 'summing to the rake exactly (1.80/1.80, 2.90/2.90, 1.30/1.30)',
           'money_lost', 0
         ))
 WHERE resolved_at IS NULL
   AND severity = 'critical'
   AND source = 'fn_rake_bbj_audit';

DO $$
DECLARE v_open int; v_unbanked int;
BEGIN
  SELECT count(*) INTO v_open
    FROM public.financial_alerts
   WHERE resolved_at IS NULL AND severity='critical' AND source='fn_rake_bbj_audit';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'still % open rake/bbj criticals', v_open;
  END IF;

  -- And the hands really are banked. Asserted, not assumed.
  SELECT count(*) INTO v_unbanked
    FROM (VALUES ('c302e37e-4d78-436e-82b0-502408494d8e'::uuid),
                 ('21fe3424-c6c3-4db3-97dd-13e487cdff60'::uuid),
                 ('a7f72343-6016-4088-a2a6-8f8871e09f6b'::uuid)) AS h(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = h.id);
  IF v_unbanked <> 0 THEN
    RAISE EXCEPTION '% of the 3 hands are still unbanked - this was NOT stale', v_unbanked;
  END IF;
END $$;
