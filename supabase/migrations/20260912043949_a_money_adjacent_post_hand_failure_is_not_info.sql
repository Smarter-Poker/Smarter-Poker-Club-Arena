-- A money adjacent post-hand failure is not info.
--
-- Drift incident bf4ef6e0-14f7-4e6f-b90c-f2bfeab4f943: the leave_pending step
-- threw six times across six cash tables on 2026-09-11 and the board recorded
-- it as INFO. The engine had raised all six as CRITICAL. This trigger
-- overruled it, and 'info' is not a colour - fn_ca_raise_drift_incident opens
-- with `IF p_severity = 'info' THEN NULL;`, so no notification is sent at all.
-- A step that returns a player's whole stack to their wallet failed six times
-- and paged nobody.
--
-- The engine has ALREADY made this judgement, and makes it well.
-- ServerTableEngineSettlement.runStep takes a `moneyCritical: boolean` and
-- raises a financial alert only when it is true. The five steps that move no
-- chips - promo_playthrough, horse_rebuys, chip_continuity, horse_cashouts,
-- deferred_sitouts - are all declared false and never reach financial_alerts
-- at all. So every postHandTasks.* row that exists here has already been
-- filtered to "this one moves chips", and re-deciding it in SQL could only
-- ever make the answer worse. It did, on two independent faults:
--
--   1. It scanned the SOURCE NAME for money words
--      (prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback).
--      'leave_pending' names no chip. It returns a departing player's stack to
--      their wallet, and it reads as engine plumbing.
--   2. It treated a missing amount as PROOF OF ZERO:
--      COALESCE(discrepancy, amount, 0) = 0. runStep has never written either
--      key into the alert context. Measured over seven days: 0 of 1,551
--      postHandTasks alerts carry one. The test was unconditionally true, so
--      this branch could only ever return 'info' - for leave_pending,
--      pending_addons, table_unlock, hand_history and rake_distribution alike.
--
-- The new rule lets the engine assert the fact instead of having SQL infer it.
-- When a future engine build puts moves_chips in the alert context, that fact
-- decides. While it is absent the answer is critical, because absent should
-- fail toward being seen, not toward silence. The cast is written as a string
-- comparison rather than ::boolean on purpose: this whole trigger ends in
-- EXCEPTION WHEN OTHERS ... RETURN NEW, so a bad cast would not raise, it
-- would silently stop creating incidents at all.
--
-- This does not flood the board. Incidents dedupe on the SHAPE of the finding,
-- so 1,508 hand_history_failed alerts fold into a small number of rows with
-- high occurrence counts, not 1,508 board items - the incident being fixed
-- here is itself six alerts folded into one. And the rate is currently zero:
-- the last postHandTasks alert of any kind was 2026-09-11 13:16:05, before
-- engine a173c5dd75 shipped the leave_pending retry at 23:57Z.
--
-- The ServerTableEngine.% arm is deliberately left exactly as it was. Those
-- sources are not gated on moneyCritical and are not this incident's to
-- re-judge.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
  v_severity text;
  v_shape text;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* A REFUSED HAND IS A RATE, NOT AN INCIDENT (2026-09-09). The atomic
     settlement contract rejects the hand write whole and rolls it back before
     any money step, so a refusal costs a hand and never a chip.
     fn_ca_hand_commit_refusals owns this question in the conservation sweep
     and raises when a reason passes 25 in a day; promoting each refused hand
     here as well only fills the money board faster than it can be read. The
     alert itself is still written to financial_alerts and still counted. */
  IF NEW.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     OR COALESCE(NEW.context->>'error', '') LIKE '%authoritative_hand_semantic_refusal%' THEN
    RETURN NEW;
  END IF;

  /* A HANDOFF THAT NAMES ITS SUCCESSOR IS NOT AN INCIDENT (2026-09-10).
     post_commit_obligations_pending says the hand COMMITTED and that the
     engine handed its post-commit envelope to the durable outbox - after
     zero attempts, because nothing failed; it stepped back at the causal
     settlement barrier and named the projection worker as its successor.
     274 of them in 24 hours and 1,485 since the source existed. Same
     reasoning as the refusal exemption above: the alert is still written
     to financial_alerts and still counted, but one board item per message
     shape for work that succeeded only fills the money board faster than
     it can be read. An outbox that stops DRAINING is a different source
     and raises on its own terms. */
  IF NEW.source = 'ServerTableEngine.post_commit_obligations_pending' THEN
    RETURN NEW;
  END IF;

  /* ONE CAUSE IS ONE INCIDENT (2026-09-09). The key is the SHAPE of the
     finding, not its instance. The error joins the key because a refusal
     message often names the hand but not the reason - "Table <id> hand #<n>
     was refused by the atomic settlement contract" is one sentence for a
     stale lease and for a vacated seat, and those are different bugs. */
  v_shape := public.fn_ca_normalize_alert_text(left(NEW.message, 200))
             || '|' ||
             public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200));

  v_dedupe := CASE
      WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
        THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
      ELSE 'fa:' || NEW.source || ':' || md5(v_shape) END;

  SELECT i.id INTO v_echo_id FROM public.ca_drift_incidents i
   WHERE i.dedupe_key = v_dedupe AND i.status = 'resolved'
     AND i.resolved_at > now() - interval '48 hours'
     AND i.suspected_cause = left(NEW.message, 300)
   ORDER BY i.resolved_at DESC LIMIT 1;
  IF v_echo_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents SET occurrences = occurrences + 1 WHERE id = v_echo_id;
    INSERT INTO public.ca_incident_events (incident_id, at, kind, actor_label, detail)
    VALUES (v_echo_id, now(), 'comment', 'system',
            jsonb_build_object('note', 'Byte-identical echo of this resolved incident re-reported by '
              || NEW.source || '; folded without re-paging (alert ' || NEW.id || ').'));
    RETURN NEW;
  END IF;

  /* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10). Engine
     plumbing that names no chip - a hand rolled back, a post-hand step that
     threw, an outbox handoff - is filed as info: written, deduped, counted,
     on the board, not red, not paged. Money-shaped sources are untouched. */
  v_severity := CASE
      WHEN NEW.source ~* 'conservation' THEN 'info'
      /* THE ENGINE ALREADY DECIDED THIS ONE (2026-09-12, incident bf4ef6e0).
         runStep raises a financial alert ONLY when its moneyCritical argument
         is true, so every postHandTasks.* row here is already filtered to "this
         moves chips" - the five steps that move none never arrive. Re-deciding
         it in SQL downgraded all of them, on a source-name scan that
         'leave_pending' fails while returning a player's whole stack, and on
         COALESCE(discrepancy, amount, 0) = 0 as proof of zero when runStep
         writes neither key (0 of 1,551 alerts in seven days). When the engine
         asserts moves_chips, that fact decides; absent, critical, because
         absent must fail toward being seen. Compared as text, not cast: this
         trigger ends in EXCEPTION WHEN OTHERS ... RETURN NEW, so a bad cast
         would silently stop creating incidents rather than raise. */
      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')
                  THEN 'info' ELSE 'critical' END
      WHEN NEW.source LIKE 'ServerTableEngine.%'
           AND NOT (NEW.source ~* 'prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback')
           AND COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                        NULLIF(NEW.context->>'amount','')::numeric, 0) = 0
        THEN 'info'
      WHEN NEW.source ~* 'prize_credit_failed'
           AND NULLIF(NEW.context->>'user_id','') IS NOT NULL
           AND public.fn_ca_is_cert_account((NEW.context->>'user_id')::uuid) THEN 'info'
      ELSE 'critical' END;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    p_severity       => v_severity,
    p_dedupe_key     => v_dedupe,
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => NULLIF(NEW.context->>'table_id','')::uuid,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;

COMMIT;
