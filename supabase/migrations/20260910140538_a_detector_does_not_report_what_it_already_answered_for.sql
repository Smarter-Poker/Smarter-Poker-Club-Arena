-- a_detector_does_not_report_what_it_already_answered_for
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- At 13:23 today incident 28119497 was resolved with a correction_ref naming
-- the two migrations that fixed the tournament-lease churn, and asserting what
-- had been measured: ZERO hand commits refused for "lease proof expired" in the
-- eleven hours since. At 13:52 the sweep opened 81150ce8 - same source, same
-- 117 refusals, all of them from 02:xx, all of them from the cause that was
-- fixed this morning.
--
-- fn_ca_hand_commit_refusals reads a ROLLING 24-hour window with a floor of 25.
-- Those 117 stay inside that window until roughly 02:00 tomorrow, so the
-- detector would have re-opened the same incident once an hour, twelve more
-- times, for a defect that no longer happens. Resolving one only lets the next
-- sweep open another.
--
-- That is the same shape as the append-only notice closed forty minutes ago
-- (a_maintenance_kind_registered_as_info_is_recorded_not_raised, 0ad5625e
-- closed at 13:23 and d03c35bf opened four minutes later) and it is what
-- CLAUDE.md 10.84 warns about: an alarm that cannot be turned off by fixing
-- anything is an alarm people learn to scroll past, and it hides the ones that
-- matter.
--
-- THE RULE: a detector reports what has happened SINCE the correction that
-- answered for it. Its window starts at the later of
--
--   (a) now() - p_hours, its own rolling window, and
--   (b) the resolved_at of the most recent RESOLVED incident for this source
--       that carries a correction_ref.
--
-- (b) is not a mute. A correction_ref is a deliberate, written assertion that
-- the cause was fixed at that moment; anything the detector sees AFTER it still
-- counts, still has to clear the same floor of 25, and still raises. What stops
-- is history being re-reported as news - which is the only thing that changed.
-- An incident resolved WITHOUT a correction_ref (verified:, no-change-needed:)
-- does not move the window at all.
--
-- This is written inline rather than as a shared helper because it is the first
-- detector to need it; the next one copies these six lines. Pinned by
-- tests/a-detector-does-not-report-what-it-already-answered-for.law.test.ts.
--
-- Asserted text substitution on the live definition: the anchor must appear
-- exactly once, and afterwards the detector must still carry its floor of 25
-- and its rolling window.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_rows integer;
  v_still integer;
  v_old text := E'       AND a.created_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))';
  v_new text := E'       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).\n'
             || E'          The window starts at the LATER of the rolling p_hours and the moment\n'
             || E'          the most recent incident for this source was resolved with a\n'
             || E'          correction_ref - a written assertion that the cause was fixed then.\n'
             || E'          Anything after that instant still counts and still raises; only\n'
             || E'          history stops being re-reported as news. A resolution with no\n'
             || E'          correction_ref (verified:, no-change-needed:) does not move it. */\n'
             || E'       AND a.created_at > GREATEST(\n'
             || E'             now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1)),\n'
             || E'             COALESCE((SELECT max(i.resolved_at) FROM public.ca_drift_incidents i\n'
             || E'                        WHERE i.source = ''fn_ca_conservation_sweep:fn_ca_hand_commit_refusals''\n'
             || E'                          AND i.status = ''resolved''\n'
             || E'                          AND COALESCE(btrim(i.correction_ref), '''') <> ''''),\n'
             || E'                      ''-infinity''::timestamptz))';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_hand_commit_refusals';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_hand_commit_refusals is missing'; END IF;

  IF position('ALREADY ANSWERED FOR' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the refusal detector carries % rolling-window clause(s), expected 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_hand_commit_refusals';
  END IF;

  -- the floor and the rolling window both survive: this narrows WHEN it looks,
  -- never HOW LOUD it has to be before it speaks
  IF position('HAVING count(*) >= 25' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal detector lost its floor of 25';
  END IF;
  IF position('make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal detector lost its rolling window';
  END IF;

  -- and it is quiet now, because everything it was reporting predates the fix
  SELECT count(*) INTO v_still FROM public.fn_ca_hand_commit_refusals();
  IF v_still <> 0 THEN
    RAISE EXCEPTION 'the refusal detector still reports % finding(s) after the correction watermark; those are NEW refusals and the cause is not fixed', v_still;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_hand_commit_refusals read a rolling 24-hour window, so the 117 "lease proof expired" refusals from 02:xx - every one of them from the tournament-lease churn fixed this morning by a_hand_commit_does_not_hold_the_lease_against_its_own_heartbeat and a_busy_manager_keeps_its_lease - stayed inside its window after 28119497 was resolved at 13:23. It would have re-opened the same incident once an hour until roughly 02:00 tomorrow, for a defect that no longer happens.',
         correction_ref = 'migration a_detector_does_not_report_what_it_already_answered_for',
         resolution = 'The detector now starts its window at the later of its rolling p_hours and the resolved_at of the most recent incident for this source that carries a correction_ref. It reports what has happened SINCE the correction. The floor of 25 and the rolling window are unchanged, so a genuinely new refusal is as loud as it ever was; asserted in this migration that the detector returns zero findings now, which is the measurement that says the cause is gone rather than merely quiet.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_conservation_sweep:fn_ca_hand_commit_refusals';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN RAISE EXCEPTION 'expected to resolve the re-raised refusal incident, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
