-- the_supply_meter_swing_did_not_repeat_and_the_ledger_balances
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Two open warnings, both from fn_ca_supply_snapshot, both a single interval:
-- a27c78f8 (-699.86 at 05:05) and cc821cae (-347.70 at 07:05). Each has
-- occurrences = 1 and has not re-fired.
--
-- WHAT WAS MEASURED, over the eight intervals since:
--
--   06:05  +590.26      10:05   -11.76
--   07:05  -347.70      11:05  -100.00
--   08:05    +0.60      12:05   -50.00
--   09:05   -88.24      13:05   -52.90
--
-- The sign alternates and the magnitude collapses: every interval since 08:05
-- is inside the meter's own alarm criteria, which require BOTH |interval| > 100
-- and |trailing 4h| > 300 before it will speak. Against roughly 20,000 chips of
-- gross movement per interval, that is noise, and the meter said so itself when
-- it raised these as warnings rather than criticals: "single-interval swing;
-- previous interval did not agree in sign."
--
-- AND THE LEDGER ITSELF BALANCES. reconcile_ledger_nightly has written
-- `ok` on all 20 runs in the last 24 hours, newest 12:55 - not one `critical`,
-- not one `warning`. No chips are missing; a reading disagreed with itself.
--
-- WHAT IS ACTUALLY WEAK, so nobody has to find it again: the meter takes its
-- ledger window bound `v_cut := clock_timestamp()` BEFORE it reads the
-- balances, so a leg committed in the gap lands in this interval's balances and
-- the next interval's issuance window - the same wall-clock-against-a-snapshot
-- shape that the ledger replay reader was rewritten for this morning
-- (`the_journal_window_is_a_snapshot_not_a_clock`, which windows by
-- pg_visible_in_snapshot instead). The meter's `felt` term also excludes
-- tournament tables by design while `table_stack` legs from tournament hands
-- feed stores it does count. Neither is a loss and neither is fixed here:
-- rewriting the platform's chip-supply meter is its own change with its own
-- measurements, and it is carried as a named follow-up rather than rushed onto
-- the end of a long session.
--
-- These two incidents are closed on the evidence above. If the reader's
-- weakness ever produces a real leak, the meter escalates to critical on
-- consecutive same-sign intervals, which is exactly the case it reserves.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_loud integer;
  v_bad_reconcile integer;
  v_trailing numeric;
  v_rows integer;
BEGIN
  -- no interval since 08:00 has crossed the meter's own alarm threshold
  SELECT count(*) INTO v_loud
    FROM public.ca_supply_snapshots s
   WHERE s.taken_at > now() - interval '5 hours'
     AND s.unexplained IS NOT NULL AND abs(s.unexplained) > 100;
  IF v_loud <> 0 THEN
    RAISE EXCEPTION '% supply interval(s) in the last five hours exceeded 100 unexplained; the swing has not settled', v_loud;
  END IF;

  SELECT COALESCE(sum(s.unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots s
   WHERE s.taken_at > now() - interval '4 hours' AND s.unexplained IS NOT NULL;
  IF abs(v_trailing) > 300 THEN
    RAISE EXCEPTION 'trailing 4h unexplained is % - the meter''s own critical threshold', round(v_trailing,2);
  END IF;

  -- and the ledger reconciler is clean over the same period
  SELECT count(*) INTO v_bad_reconcile
    FROM public.ledger_reconcile_log r
   WHERE r.created_at > now() - interval '24 hours'
     AND lower(COALESCE(r.severity,'')) NOT IN ('ok', 'info');
  IF v_bad_reconcile <> 0 THEN
    RAISE EXCEPTION '% ledger reconcile finding(s) in the last 24 hours are not ok', v_bad_reconcile;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'A single-interval reading of fn_ca_supply_snapshot disagreed with the next one. The meter bounds its issuance window with clock_timestamp() taken BEFORE it reads the balances, so a leg committed in that gap is counted in this interval''s balances and the next interval''s issuance - the same wall-clock-against-a-snapshot shape the ledger replay reader was rewritten for this morning. Its `felt` term also excludes tournament tables by design while table_stack legs from tournament hands feed stores it does count.',
         correction_ref = 'verified: every interval since 08:05 is inside the meter''s own alarm criteria (|interval|<=100, trailing 4h within 300) and reconcile_ledger_nightly has written ok on all 20 runs in the last 24 hours - no chips are missing',
         resolution = 'Closed on the evidence: the swing did not repeat, the sign alternated, and the ledger balances. The reader''s wall-clock window is a real weakness and is carried as a named follow-up to be rewritten the way the replay reader was (window by pg_visible_in_snapshot); it is not a loss, and the meter still escalates to critical on consecutive same-sign intervals, which is the case that would matter.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_supply_snapshot';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'expected to resolve 2 supply-snapshot warnings, resolved %', v_rows;
  END IF;
END
$body$;

COMMIT;
