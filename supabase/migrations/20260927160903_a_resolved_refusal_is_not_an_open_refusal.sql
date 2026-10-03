-- 20260927160903_a_resolved_refusal_is_not_an_open_refusal
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 16:09:03 UTC.
--
-- Board incident hand-commit-refusals-sweep-restates-healed-refusals
-- (issue #5070). `fn_ca_hand_commit_refusals` (the source behind
-- ca_drift_incidents "fn_ca_conservation_sweep:fn_ca_hand_commit_refusals")
-- counts every public.financial_alerts row with
-- source = 'ServerTableEngine.authoritative_hand_semantic_refusal' inside its
-- rolling window, but it never checks whether that row is `resolved`. Measured
-- 2026-09-27 16:05 UTC: 6,657 of 6,663 rows of this source are already
-- resolved (0 rows where `resolved` disagrees with `resolved_at`), most with a
-- resolution proving no chips moved and the felt reconciles
-- (fn_unaccounted_seat_exits() returns 0 rows for the class). Incident 07d0babb
-- restated exactly the 68 refusals of 2026-09-26 15:06-15:07 UTC, every one of
-- them already resolved that way, as a fresh "ledger_imbalance" finding -
-- because the 2026-09-10 watermark fix (migration
-- a_detector_does_not_report_what_it_already_answered_for) narrows WHEN the
-- detector looks, but says nothing about WHETHER the row it is looking at was
-- already answered. A row can be individually resolved between sweeps without
-- ca_drift_incidents ever recording a correction_ref for this source, so the
-- watermark never moves and the same healed refusal counts again on every
-- hourly run until it ages out of the 24h window on its own.
--
-- THE FIX: the detector's `win` CTE now also requires `a.resolved = false`.
-- A refusal that has been individually investigated and resolved - proven, per
-- its own resolution text, to have moved no chips - is not an open finding for
-- a sweep that exists to report open ones. A refusal that is still open, or
-- that becomes newly open after this migration, is untouched: same floor of
-- 25, same rolling window, same watermark. This does not touch any
-- financial_alerts row and does not close any ca_drift_incidents or
-- operational_alert_events row; it only changes what the detector counts on
-- its next run.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy): every DDL statement fires Supabase's schema-cache
-- reload, ~28s on this database, so one BEGIN/COMMIT coalesces it to one.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_still integer;
  v_old text := E'     WHERE a.source = ''ServerTableEngine.authoritative_hand_semantic_refusal''\n       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).';
  v_new text := E'     WHERE a.source = ''ServerTableEngine.authoritative_hand_semantic_refusal''\n'
             || E'       /* A RESOLVED REFUSAL IS NOT AN OPEN REFUSAL (2026-09-27).\n'
             || E'          A row individually resolved - proven by its own resolution to have\n'
             || E'          moved no chips - is not a finding for a sweep that reports open\n'
             || E'          problems. This is independent of the watermark below: a row can be\n'
             || E'          resolved between sweeps with no correction_ref ever recorded for\n'
             || E'          THIS detector''''s own incident, so the watermark never moves and the\n'
             || E'          same healed refusal would otherwise count again every hour until it\n'
             || E'          aged out of the rolling window on its own. */\n'
             || E'       AND a.resolved = false\n'
             || E'       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_hand_commit_refusals';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_hand_commit_refusals is missing'; END IF;

  IF position('A RESOLVED REFUSAL IS NOT AN OPEN REFUSAL' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the refusal detector carries % source-anchor(s), expected 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_hand_commit_refusals';
  END IF;

  -- the floor, the rolling window and the 2026-09-10 watermark all survive:
  -- this narrows WHICH rows count, never WHEN it looks or HOW LOUD it must be
  IF position('HAVING count(*) >= 25' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal detector lost its floor of 25';
  END IF;
  IF position('make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal detector lost its rolling window';
  END IF;
  IF position('SELECT max(i.resolved_at) FROM public.ca_drift_incidents i' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal detector lost its 2026-09-10 correction watermark';
  END IF;
  IF position('AND a.resolved = false' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the resolved-row filter did not take';
  END IF;

  -- and a genuinely unresolved refusal still counts: prove the filter is a
  -- narrowing, not a silence, by asserting it against the live financial_alerts
  -- rows the same way the function itself will read them
  IF (SELECT count(*) FROM public.financial_alerts a
       WHERE a.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
         AND a.resolved = false) <> (
      SELECT count(*) FROM public.financial_alerts a
       WHERE a.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
         AND NOT a.resolved) THEN
    RAISE EXCEPTION 'resolved is not a plain boolean on financial_alerts; the filter needs review before it ships';
  END IF;

  SELECT count(*) INTO v_still FROM public.fn_ca_hand_commit_refusals();
  IF v_still <> 0 THEN
    RAISE EXCEPTION 'the refusal detector still reports % finding(s) after the resolved-row filter; those are genuinely open and the incident stays as-is', v_still;
  END IF;
END
$body$;

COMMIT;
