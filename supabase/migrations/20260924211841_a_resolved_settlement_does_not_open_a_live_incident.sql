/* A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT (2026-09-24)

   fn_ca_financial_alert_to_incident fires AFTER INSERT ON financial_alerts and,
   unless one of a handful of named exemptions applies, always raises a fresh
   ca_drift_incidents row for a 'critical' alert - regardless of whether the
   alert it was just handed is a live, unresolved problem or an
   already-resolved audit record. financial_alerts.resolved is boolean NOT
   NULL DEFAULT false, and every ordinary live writer leaves it at that
   default; the only rows ever inserted with resolved=true are the audit
   proofs a settlement migration writes about damage it has ALREADY fixed and
   restored in the same transaction (the pattern used by, e.g.,
   20260923204615_restore_blind_levels_the_clock_burned_with_a_live_lease_and_.sql).

   Because the trigger is AFTER INSERT ONLY - nothing ever revisits a
   financial_alerts row afterward - an incident opened from one of these
   already-resolved rows can never close itself. It sits open, unclassified
   (root_cause null, classification 'unknown', auto_repair_status
   'manual_needed'), while a daily escalation tick keeps touching it and the
   operational-source-intake mirror (direct-operational-source-intake) faithfully
   re-captures each touch as a fresh 'new' row in operational_alert_events -
   so an already-fixed, already-proven-fixed condition pages forever as if it
   were still live.

   Found via the Production Alerts Fleet board (issue #5070): the alert
   'financial_alerts:tournament.blind_clock_burned_past_its_witness' recurred
   in operational_alert_events on 2026-09-23 (four times within 16 minutes of
   creation) and again on 2026-09-24 - a full day after the migration that
   created it had already restored both affected tournaments to current_level
   0 (verified live: e9c07fe8-bc97-43c5-a506-54bdcb931878 and
   114c6069-d6dc-4b6d-97dd-65e909446a3d both still at current_level=0,
   unchanged since the restore). The underlying blind-clock bug itself was
   already fixed at the root on 2026-09-23 by
   20260923165845_restore_blind_levels_burned_by_a_stalled_tournament_clock.sql
   (code fix: server/src/tournament/TournamentManagerBase.ts advanceBlindLevel,
   pinned by tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts)
   and its derivation gap closed the same day by
   20260923204615_restore_blind_levels_the_clock_burned_with_a_live_lease_and_.sql.
   What was still open was never the blind clock - it was this trigger opening
   an incident about a settlement it was simultaneously being told is resolved.

   THE FIX: skip incident creation entirely when the inserted row already
   carries resolved=true. It is still written to financial_alerts (the
   historical record stands, as does the requirement that nothing here is
   silently dropped); it simply never enters the open-incident/escalation
   path meant for conditions that still need someone's attention.

   Three stray incidents from 2026-09-23's settlement runs match this exact
   shape - raised in the same instant as an already-resolved financial_alerts
   row, never touched again except by escalation, still open - and are
   resolved here with their cause named. */
BEGIN;

DO $mig$
DECLARE v_src text; v_new text; v_anchor text; v_insert text; v_n int; v_resolved int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_financial_alert_to_incident';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_financial_alert_to_incident not found'; END IF;

  IF position('A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; skipping the function';
  ELSE
    v_anchor := '  IF NEW.severity <> ''critical'' THEN RETURN NEW; END IF;' || E'\n' ||
                '  IF NEW.source LIKE ''drift_incident:%'' THEN RETURN NEW; END IF;';
    v_n := (length(v_src)-length(replace(v_src,v_anchor,'')))/length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the two early-return guards appear % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;
    v_insert := v_anchor || E'\n\n' ||
      '  /* A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT (2026-09-24). A' || E'\n' ||
      '     row inserted already resolved=true is a settlement''s own proof that' || E'\n' ||
      '     the damage it names is already fixed and restored - not a live' || E'\n' ||
      '     condition. This trigger is AFTER INSERT ONLY, so an incident opened' || E'\n' ||
      '     here from an already-resolved row can never close itself; it would' || E'\n' ||
      '     sit open and re-escalate forever for something already fixed. */' || E'\n' ||
      '  IF NEW.resolved THEN RETURN NEW; END IF;';
    v_new := replace(v_src, v_anchor, v_insert);
    IF v_new = v_src THEN RAISE EXCEPTION 'substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  /* Resolve the stray incidents opened from an already-resolved settlement
     row on 2026-09-23, before this fix existed. Matched by shape: raised in
     the same instant as a financial_alerts row that already carried
     resolved=true, never advanced past occurrences=1. */
  UPDATE public.ca_drift_incidents i
     SET status='resolved', resolved_at=now(),
         correction_ref='migration a_resolved_settlement_does_not_open_a_live_incident',
         classification = CASE WHEN i.classification='unknown' THEN 'settlement_error' ELSE i.classification END,
         root_cause = 'fn_ca_financial_alert_to_incident raised this incident from a financial_alerts row that was inserted already resolved=true - a settlement migration''s own audit proof of damage it had already fixed in the same transaction, not a live condition. The trigger never checked NEW.resolved, and being AFTER INSERT ONLY it could never revisit the row to close what it should never have opened. Fixed at the root in this migration: an already-resolved insert no longer raises an incident at all.',
         resolution = 'The event this incident names was already fixed and restored before this incident was ever raised (see the financial_alerts row it was raised from, and its own settlement migration). No further action needed on the underlying event; this incident itself was the defect.'
   WHERE i.status='open'
     AND i.occurrences=1
     AND EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.resolved=true
          AND fa.source = replace(i.source,'financial_alerts:','')
          AND abs(extract(epoch from (i.created_at - fa.created_at))) < 5
     );
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RAISE NOTICE 'an already-resolved settlement no longer opens a live incident; % stray incidents from 2026-09-23 resolved with cause', v_resolved;
END $mig$;

COMMIT;
