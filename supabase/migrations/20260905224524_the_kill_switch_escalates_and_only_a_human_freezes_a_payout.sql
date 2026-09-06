-- 20260905224524_the_kill_switch_escalates_and_only_a_human_freezes_a_payout.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 6 gate, 2026-09-05 22:5x UTC):
--
-- I BROKE A WRITTEN LAW AND SHIPPED IT. Phase 6.2 (migration 20260905203905)
-- built the roadmap's "kill switch automation at Dan's threshold" as a
-- detector that OPENS the payout freeze itself, at a threshold I chose. The
-- law tests/law/PayoutFreezeIsHumanOnly.law.test.ts, written 2026-09-02, says
-- the opposite in as many words:
--
--   "THE PAYOUT FREEZE IS OPENED BY A HUMAN, NEVER BY A DETECTOR ... A switch
--   a person throws after reading the trial balance is a control. A switch a
--   detector throws on a threshold is exactly the false-alarm mechanism that
--   pays nobody for an hour because a snapshot was re-based ... The threshold
--   itself is Dan's decision (standard section 6 item 2) and has not been
--   made. ... If you are here because you want the trial balance to open the
--   freeze automatically: that is a decision for Dan, not a test to weaken."
--
-- The full test suite caught it at the gate (the pre-push hook runs the tests
-- covering the diff, and this law reads every migration instead). The law is
-- right, and today's own meter proves it: at 03:05 UTC the supply meter read
-- -3,305.68 unexplained in one hour. Nothing leaked. The meter had changed
-- DEFINITION at 02:56 (Phase 5.1, tournament liability from counters to the
-- escrow banks). An armed switch at 1,000 chips would have frozen every
-- tournament payout on the platform at 03:05, and again whenever a meter is
-- re-based - the exact failure the law was written about, on the exact day I
-- armed it.
--
-- CORRECTED FORWARD, and production was disarmed first (ca_kill_switch_policy
-- .armed = false, 22:5x UTC, before this migration: the policy is data, so the
-- automation stopped the moment it was read rather than when this applied).
-- fn_ca_kill_switch_trip no longer touches ca_payout_freeze at all. It
-- ESCALATES: a critical incident, a senior page, a financial alert, at the
-- same thresholds. So the meters still shout at 1,000 chips and a person
-- decides whether to throw the switch - which is what the law asks for and
-- what the roadmap's "at Dan's threshold" always meant.
--
-- KEPT, because it extends the HUMAN switch rather than replacing it: the
-- 'bbj_payouts' scope, which bbj_atomic_payout_v2 reads. Before Phase 6 a
-- person could freeze tournament payouts and diamonds but had no way to stop
-- a jackpot payout; now the same human door covers it, refusing with a
-- message the engine's queue retries so nothing is lost while frozen. Reading
-- the table is not opening it.
--
-- FOR DAN, with the cost, since the law says the threshold is his:
--   Option A (in force now): the meters escalate at 1,000 chips and a person
--     opens the freeze. Cost: minutes of human latency on a real leak.
--   Option B: the switch opens the freeze itself at 1,000 chips. Cost: a
--     meter re-definition or a bad snapshot freezes every payout until a
--     person clears it; it would have fired once today on a definition change
--     (-3,305.68 at 03:05) and never on a real movement. The 22 other hourly
--     readings today were between -193.33 and +659.08, and the 14 hours since
--     the meter became exact were all within +/- 7.
--   Recommendation: A until the meter has run a week inside +/- 50 an hour,
--     then B at a threshold set from that week's spread, armed one meter at a
--     time. Nothing in the machinery changes to move between them: it is the
--     armed flag and one function body.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

COMMENT ON TABLE public.ca_kill_switch_policy IS
  'Chip standard Phase 6.2, corrected at the Phase 6 gate: the threshold at which each meter ESCALATES (critical incident, senior page, financial alert). It does not open the payout freeze: tests/law/PayoutFreezeIsHumanOnly.law.test.ts says a person opens that after reading the numbers, and the threshold for any automatic opening is Dan''s decision. armed = the escalation is on.';

ALTER TABLE public.ca_kill_switch_policy ALTER COLUMN scopes SET DEFAULT ARRAY[]::text[];
COMMENT ON COLUMN public.ca_kill_switch_policy.scopes IS
  'Kept for the record of what an automatic switch WOULD have frozen if Dan rules for it; nothing reads it while the switch only escalates.';

CREATE OR REPLACE FUNCTION public.fn_ca_kill_switch_trip(p_detector text, p_amount numeric, p_detail text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE pol public.ca_kill_switch_policy%ROWTYPE; v_inc uuid; v_hour text := to_char(now(), 'YYYY-MM-DD-HH24');
BEGIN
  SELECT * INTO pol FROM public.ca_kill_switch_policy WHERE detector = p_detector;
  IF NOT FOUND OR NOT pol.armed OR p_amount IS NULL OR abs(p_amount) < pol.threshold_chips THEN
    RETURN false;
  END IF;
  /* THE SWITCH ESCALATES; A PERSON FREEZES. This function must never write
     ca_payout_freeze: tests/law/PayoutFreezeIsHumanOnly.law.test.ts pins that
     the only INSERT into that table anywhere is inside the human opener, and
     a detector that freezes on a threshold pays nobody for an hour when a
     meter is re-based (measured on this platform at 03:05 UTC today:
     -3,305.68 from a definition change, not a movement). */
  v_inc := public.fn_ca_raise_drift_incident(
    'fn_ca_kill_switch_trip', 'ledger_imbalance', 'critical',
    'kill-switch:' || p_detector || ':' || v_hour,
    round(p_amount, 2), NULL, NULL, 'ledger', 'ca_kill_switch_policy', NULL,
    'fade0000-0000-0000-0000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s (threshold %s). Payouts are NOT frozen: read the trial balance and the last two snapshots, then open the freeze yourself with fn_ca_open_payout_freeze if this is a real movement. A meter that has just changed definition reads like a leak and is not one.',
           p_detector, p_detail, pol.threshold_chips),
    false, jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips, 'freeze', 'human only'));
  IF v_inc IS NOT NULL THEN
    PERFORM public.fn_ca_incident_notify(v_inc, 'escalated', format('KILL SWITCH: %s read %s; a person decides whether to freeze', p_detector, round(p_amount, 2)), true);
  END IF;
  PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s. Payouts are NOT frozen - a person opens the freeze after reading the numbers.', p_detector, p_detail),
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips),
    'kill-switch:' || p_detector || ':' || v_hour);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
      format('KILL SWITCH by %s could not complete its paging: %s', p_detector, SQLERRM), jsonb_build_object('detector', p_detector), 'kill-switch-error:' || v_hour);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) TO service_role;

-- Re-armed as an ESCALATION on all three meters: it now shouts, it does not freeze.
UPDATE public.ca_kill_switch_policy
   SET armed = true, scopes = ARRAY[]::text[], updated_at = now(),
       note = 'escalates at ' || threshold_chips || ' chips (critical incident, senior page, alert); a person opens the payout freeze. Disarmed 22:5x and re-armed as escalation by migration 20260905224524.'
 WHERE detector IN ('fn_ca_supply_snapshot', 'fn_bbj_reconcile', 'fn_ca_escrow_balance_drift');

DO $$
DECLARE v_open int;
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_kill_switch_trip') LIKE '%INSERT INTO public.ca_payout_freeze%' THEN
    RAISE EXCEPTION 'the kill switch still writes the payout freeze';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_kill_switch_trip') NOT LIKE '%A PERSON FREEZES%' THEN
    RAISE EXCEPTION 'the kill switch does not carry the law it obeys';
  END IF;
  SELECT count(*) INTO v_open FROM public.ca_payout_freeze WHERE cleared_at IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION '% payout freezes are open; the switch opened one before it was corrected - read them before clearing', v_open;
  END IF;
  IF (SELECT count(*) FROM public.ca_kill_switch_policy WHERE armed) <> 3 THEN
    RAISE EXCEPTION 'the escalation is not armed on three meters';
  END IF;
END $$;

COMMIT;
