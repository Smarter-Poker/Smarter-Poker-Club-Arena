-- ONLY A CRITICAL THAT NEEDS A PERSON REACHES A PERSON.
--
-- Dan, 2026-09-06: "HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR
-- FIXES, ONLY CRITICAL ERRORS THAT NEED MY ATTENTION ONLY SHOULD BE SENT TO MY
-- PHONE."
--
-- Two defects, one symptom. His phone was being paged several times an hour for
-- money that was correct.
--
-- ============================================================================
-- A1. fn_ca_escrow_on_close JUDGES A POSTCONDITION AS IF IT WERE A PRECONDITION
-- ============================================================================
-- It is an AFTER UPDATE trigger on tournaments, firing the instant status
-- becomes COMPLETED. At that instant the prizes HAVE NOT BEEN PAID YET - the
-- reconciler settles seconds later - so prize_balance is still the whole prize
-- pool, and the trigger reports that pool as chips "still in escrow".
--
-- MEASURED, the ten most recent it filed:
--
--   8 of 10 now read prize_balance 0.00. The amount it reported was the prize
--   about to be paid. Checked three against the tournaments themselves:
--
--     NLH Heads-Up 100 Turbo  prize_out 2375.00  prize_balance 0.00  paid 2375.00
--     NLH Heads-Up 50 Turbo   prize_out 1520.00  prize_balance 0.00  paid 1520.00
--     PLO4 Heads-Up 100 Turbo prize_out 1425.00  prize_balance 0.00  paid 1425.00
--
--   2 of 10 are genuinely non-zero (20 Chip Spin PLO4 55.20, NLH Heads-Up 20
--   Turbo 217.36). So it is right about a fifth of the time and pages every
--   time, which is how a real signal gets trained out of a person.
--
-- 17 of the 40 incidents raised in three hours came from this one trigger.
--
-- THE FIX IS NOT A SWEEP THAT CLEANS UP AFTER IT (Dan's other ruling this
-- session). It is that a check which cannot yet know the answer must not
-- answer. The close trigger keeps doing the one thing it is genuinely in
-- position to do - stamping closed_at and close_note, the audit trail of what
-- the balances were at the moment of close - and stops raising an incident.
--
-- NOTHING IS LOST. fn_ca_escrow_vs_counter_check already detects genuinely
-- stuck escrow, runs after settlement has had time to happen, and is the source
-- of the 30 standing `escrow:<tournament>` incidents. The close-time raise was
-- a second, earlier, wronger opinion about the same question.
--
-- ============================================================================
-- A2. fn_ca_incident_notify PAGES ON WARNINGS, ON ZEROS, AND ON FIXES
-- ============================================================================
-- Reading the function: it is called for anything that is not `info` and not
-- storm-suppressed, and its v_kind is 'raised', 'escalated' OR **'resolved'**.
-- So a warning pages, an incident carrying 0.00 pages, and closing one pages
-- again. Dan asked for none of those.
--
-- The three gates below are on the PUSH ONLY. Every incident still lands on the
-- board, every ca_incident_events row is still written, and the reason a
-- notification was withheld is recorded on the incident so the board can say
-- "this happened and we deliberately did not wake anybody".

BEGIN;

-- ---------------------------------------------------------------------------
-- FIRST: ca_incident_events must be able to record a withheld notification.
--
-- Found by this migration's own probe, which is the point of having one. The
-- first version inserted kind='notify_withheld' into ca_incident_events, whose
-- CHECK constraint does not allow it, so the insert threw, the function's outer
-- EXCEPTION WHEN OTHERS caught it, and the gate silently did nothing at all.
--
-- That is the SAME defect recorded this morning in
-- docs/changelog/2026-09-06-the-deep-dive-that-found-two-of-my-own.md - a
-- swallow-all handler hiding a real failure - written a second time, hours
-- after writing it down. The probe caught it in ten seconds. A source-reading
-- test would have passed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_incident_events DROP CONSTRAINT IF EXISTS ca_incident_events_kind_check;
ALTER TABLE public.ca_incident_events ADD CONSTRAINT ca_incident_events_kind_check
  CHECK (kind = ANY (ARRAY[
    'created','recurred','notified','escalated','status_change','repair_action',
    'comment','assigned','acknowledged','resolved','reopened','notify_failed',
    -- 2026-09-06: a notification deliberately not sent, and why. The board can
    -- now show "this happened and nobody was woken", which is different from
    -- both "nobody was told" and "the notifier broke".
    'notify_withheld']));

-- ---------------------------------------------------------------------------
-- A1: the close trigger records, and stops guessing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v public.tournament_escrow%ROWTYPE;
BEGIN
  IF NEW.status <> 'COMPLETED' OR OLD.status = 'COMPLETED' THEN RETURN NULL; END IF;
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = NEW.id;
  IF NOT FOUND OR NOT v.enforced THEN RETURN NULL; END IF;

  /* Stamp what the balances were at the moment of close. This is the honest
     part: it is a fact about this instant, and it is the audit trail. */
  UPDATE public.tournament_escrow
     SET closed_at = now(),
         close_note = CASE
           WHEN abs(v.prize_balance) <= 0.05 AND abs(v.bounty_balance) <= 0.05
             THEN 'closed at zero'
           ELSE format(
             'closed with prize %s, bounty %s, fee %s still to settle; '
             || 'fn_ca_escrow_vs_counter_check judges this after settlement',
             v.prize_balance, v.bounty_balance, v.fee_balance)
         END
   WHERE tournament_id = NEW.id;

  /* AND STOPS THERE. It used to raise a drift incident here whenever prize or
     bounty was non-zero, which at this instant it almost always is - the
     reconciler has not run yet. Eight of the ten most recent such incidents now
     read prize_balance 0.00, and the amount each reported was the prize that
     was about to be paid correctly. A check that cannot yet know the answer
     must not answer. fn_ca_escrow_vs_counter_check asks the same question later,
     when the answer exists, and files the 30 standing incidents that are real. */
  RETURN NULL;
END $fn$;

-- Close the ones it already filed. They are not money; they are a clock error.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260906132947_only_a_critical_that_needs_a_person_reaches_a_person',
       root_cause = 'fn_ca_escrow_on_close judged the escrow balance at the instant the tournament reached COMPLETED, which is before the reconciler pays the prizes, so it reported the prize pool itself as chips left in escrow.',
       resolution = 'Closed 2026-09-06. Eight of the ten most recent of these now read '
         || 'prize_balance 0.00 and the amount each reported was the prize that was paid '
         || 'seconds later - verified against tournament_payouts for three of them, where '
         || 'prize_out equalled the sum of the payout rows exactly. The close trigger no '
         || 'longer raises; it stamps closed_at and close_note only. Genuinely stuck escrow '
         || 'is still detected by fn_ca_escrow_vs_counter_check, which asks after settlement '
         || 'has had time to happen. No sweep was added.'
 WHERE status <> 'resolved' AND source = 'fn_ca_escrow_on_close';

-- ---------------------------------------------------------------------------
-- A2: only a critical that needs a person reaches a person
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_incident_notify(
  p_incident_id uuid, p_kind text, p_headline text, p_senior_only boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $notify$
DECLARE
  inc  public.ca_drift_incidents;
  rec  uuid;
  n    int := 0;
  club_name  text;
  union_name text;
  body text;
  age_min int;
  v_finding text;
  v_state   text;
  v_kind    text;
  v_fresh   boolean;
  v_withheld text := NULL;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_kind := CASE
              WHEN p_kind = 'escalated'    THEN 'escalated'
              WHEN inc.status = 'resolved' THEN 'resolved'
              ELSE 'raised'
            END;

  /* DAN'S RULE, 2026-09-06. Three gates, on the PUSH only. The incident is
     still filed, the event row is still written, the board still shows
     everything - what changes is whose night it interrupts.

     Order matters: 'resolved' is checked first because a fix is the case he
     named explicitly, and it would otherwise slip through on a critical. */
  IF v_kind = 'resolved' THEN
    v_withheld := 'a fix is not a page';
  ELSIF lower(COALESCE(inc.severity,'')) <> 'critical' THEN
    v_withheld := 'severity ' || COALESCE(inc.severity,'null') || ' is not critical';
  ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 THEN
    v_withheld := 'nothing is unaccounted for (0.00)';
  END IF;

  IF v_withheld IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (inc.id, 'notify_withheld',
            jsonb_build_object('reason', v_withheld, 'kind', v_kind,
                               'severity', inc.severity,
                               'discrepancy', inc.discrepancy_amount,
                               'headline', left(p_headline, 110),
                               'rule', 'Dan 2026-09-06: only critical errors that need my attention'));
    RETURN 0;
  END IF;

  SELECT name INTO club_name  FROM public.clubs  WHERE id = inc.club_id;
  SELECT name INTO union_name FROM public.unions WHERE id = inc.union_id;
  age_min := GREATEST(0, floor(extract(epoch FROM now() - inc.detected_at) / 60))::int;

  body := format(
    '%s | %s drift %s chips (%s layer). Expected %s, actual %s. %s%sAge %smin, reconcile target %s. Auto-repair: %s.',
    upper(inc.severity), inc.classification,
    to_char(COALESCE(inc.discrepancy_amount,0), 'FM999999999990.00'),
    inc.layer,
    COALESCE(to_char(inc.expected_amount,'FM999999999990.00'),'?'),
    COALESCE(to_char(inc.actual_amount,'FM999999999990.00'),'?'),
    COALESCE('Club ' || club_name || '. ', ''),
    COALESCE('Union ' || union_name || '. ', ''),
    age_min, to_char(inc.deadline_at, 'HH24:MI UTC'), inc.auto_repair_status);

  v_finding := public.fn_ca_finding_key(inc.dedupe_key, inc.classification, inc.layer,
                                        inc.club_id, inc.union_id);
  v_state := md5(
      v_kind
      || '|' || COALESCE(inc.severity,'?')
      || '|' || COALESCE(inc.classification,'?')
      || '|' || COALESCE(inc.layer,'?')
      || '|' || COALESCE(inc.club_id::text,'-')
      || '|' || COALESCE(inc.union_id::text,'-')
      || '|' || CASE WHEN v_kind = 'escalated'
                     THEN COALESCE(inc.escalation_level, 0)::text ELSE '' END);

  FOR rec IN SELECT unnest(public.fn_ca_incident_recipient_ids(inc, p_senior_only))
  LOOP
    BEGIN
      v_fresh := NULL;
      INSERT INTO public.ca_incident_notify_ledger AS l
        (recipient_id, finding_key, state_hash, last_kind, last_incident_id)
      VALUES (rec, v_finding, v_state, v_kind, inc.id)
      ON CONFLICT (recipient_id, finding_key) DO UPDATE
        SET state_hash = EXCLUDED.state_hash, last_kind = EXCLUDED.last_kind,
            last_incident_id = EXCLUDED.last_incident_id, last_sent_at = now(),
            send_count = l.send_count + 1
        WHERE l.state_hash IS DISTINCT FROM EXCLUDED.state_hash
      RETURNING true INTO v_fresh;

      IF NOT COALESCE(v_fresh, false) THEN
        INSERT INTO public.ca_incident_events (incident_id, kind, detail)
        VALUES (inc.id, 'notified',
                jsonb_build_object('already_reported', true, 'finding_key', v_finding,
                                   'state', v_kind, 'recipient', rec));
        CONTINUE;
      END IF;

      PERFORM public.fn_raise_notification(
        rec, 'financial_incident', left(p_headline, 110), left(body, 480),
        '/hub/club-arena/financial-incidents?id=' || inc.id::text,
        jsonb_build_object('incident_id', inc.id, 'finding_key', v_finding,
                           'classification', inc.classification, 'severity', inc.severity,
                           'discrepancy', inc.discrepancy_amount, 'club_id', inc.club_id,
                           'union_id', inc.union_id, 'deadline_at', inc.deadline_at));
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'notify_failed',
              jsonb_build_object('recipient', rec, 'error', SQLERRM));
    END;
  END LOOP;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (inc.id, p_kind,
          jsonb_build_object('headline', p_headline, 'recipients', n,
                             'senior_only', p_senior_only, 'age_min', age_min,
                             'finding_key', v_finding, 'state', v_kind));
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_notify failed for %: %', p_incident_id, SQLERRM;
  RETURN 0;
END $notify$;

REVOKE ALL ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_notify(uuid, text, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- PROVE IT, then put it back.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_inc uuid; v_sent int; v_done boolean := false; v_withheld int;
BEGIN
  BEGIN
    /* Insert the probe incidents DIRECTLY rather than through
       fn_ca_raise_drift_incident: the raiser can legitimately decline (scope,
       a retired source, its own storm suppressor at >=10 incidents in two
       minutes) and return NULL, and a probe that silently tests nothing is
       worse than no probe. What is under test here is the notifier. */
    INSERT INTO public.ca_drift_incidents
      (classification, severity, layer, source, dedupe_key, discrepancy_amount, suspected_cause)
    VALUES ('ledger_imbalance','warning','ledger','zz_verify.notify','zz-verify-warn',500,'verify')
    RETURNING id INTO v_inc;
    v_sent := public.fn_ca_incident_notify(v_inc,'notified','verify warning',false);
    IF v_sent <> 0 THEN RAISE EXCEPTION 'VERIFY FAILED: a warning paged % recipient(s)', v_sent; END IF;

    INSERT INTO public.ca_drift_incidents
      (classification, severity, layer, source, dedupe_key, discrepancy_amount, suspected_cause)
    VALUES ('ledger_imbalance','critical','ledger','zz_verify.notify','zz-verify-zero',0,'verify')
    RETURNING id INTO v_inc;
    v_sent := public.fn_ca_incident_notify(v_inc,'notified','verify zero',false);
    IF v_sent <> 0 THEN RAISE EXCEPTION 'VERIFY FAILED: a 0.00 critical paged'; END IF;

    UPDATE public.ca_drift_incidents
       SET status='resolved', resolved_at=now(),
           correction_ref='verified: notification self-test',
           root_cause='A probe incident raised by this migration to prove that closing an incident does not page anybody.',
           resolution='verify close'
     WHERE id = v_inc;
    v_sent := public.fn_ca_incident_notify(v_inc,'notified','verify resolved',false);
    IF v_sent <> 0 THEN RAISE EXCEPTION 'VERIFY FAILED: a resolution paged'; END IF;

    SELECT count(*) INTO v_withheld FROM public.ca_incident_events
     WHERE kind = 'notify_withheld' AND at > now() - interval '2 minutes';
    IF v_withheld < 3 THEN
      RAISE EXCEPTION 'VERIFY FAILED: expected >=3 withheld records, found %', v_withheld;
    END IF;

    /* AND THE OTHER DIRECTION, which matters just as much: a real critical
       carrying real chips must STILL reach somebody. If this stops working the
       gates have been drawn too tight and a genuine loss goes unread. */
    INSERT INTO public.ca_drift_incidents
      (classification, severity, layer, source, dedupe_key, discrepancy_amount, suspected_cause,
       club_id)
    VALUES ('ledger_imbalance','critical','ledger','zz_verify.notify','zz-verify-real',12345.67,'verify',
            (select id from public.clubs order by created_at limit 1))
    RETURNING id INTO v_inc;
    v_sent := public.fn_ca_incident_notify(v_inc,'notified','verify real critical',false);
    IF EXISTS (SELECT 1 FROM public.ca_incident_events
                WHERE incident_id = v_inc AND kind = 'notify_withheld') THEN
      RAISE EXCEPTION 'VERIFY FAILED: a real critical carrying 12345.67 chips was WITHHELD';
    END IF;

    v_done := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN RAISE; END IF;
  END;

  IF NOT v_done THEN RAISE EXCEPTION 'VERIFY FAILED: the notification probe did not complete'; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents WHERE source = 'zz_verify.notify') THEN
    RAISE EXCEPTION 'VERIFY FAILED: probe incidents survived their rollback';
  END IF;
  RAISE NOTICE 'NOTIFY_GATES_VERIFIED warning/zero/resolved withheld, real critical still delivered, probe rolled back';
END $verify$;

COMMIT;
