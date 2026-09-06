-- A RETIRED DETECTOR AND A SUPERSEDED RUN DO NOT HOLD THE BOARD OPEN.
--
-- Two populations of open alerts, 152 rows between them, neither of which is a
-- live condition. Both are mine.
--
-- 1. fn_ca_settle_hand_stacks_absolute, 58 rows. This detector was RETIRED at
--    the Phase 6.3 gate with the note "the engine writes stacks in delta mode
--    since 2026-09-04 19:00 (PR #2958); an absolute-mode finding is
--    impossible". Retiring the detector left its findings open. Every one of
--    the 58 was filed before the engine changed mode - the newest is
--    2026-09-04 10:48, eight hours before delta mode went live - so not one of
--    them describes anything the platform can still do.
--
-- 2. drift_incident:fn_ca_ledger_replay, 94 of 95 rows. The replay was built
--    yesterday and judged five times while I was still fixing its keying: 60
--    findings at 00:33, 9 at 00:42, 11 at 00:44, 14 at 01:12 and 1 at 01:21.
--    The first four runs are superseded by migrations I applied between them -
--    20260906003739 (key an account by what OWNS the chips, which was three
--    keying bugs at once), 20260906004441 (read the balances and the journal at
--    one instant) and 20260906011716 (a residue that already cancelled is not a
--    finding). Each run's findings were answered by the next migration, and the
--    run after 20260906011716 filed exactly one.
--
--    THAT ONE STAYS OPEN. 01:21, table_stack, -10.74 chips: the felt, and it is
--    a real standing condition, not a keying artefact. The engine writes a
--    hand's stacks and its rake and jackpot legs in two transactions, so at any
--    instant a population of hands has stacks written and legs pending. It
--    flips sign as hands settle and does not accumulate. It is named as chip
--    standard item 8.5 and it is the engine lane's to close. Resolving it to
--    tidy the board would be exactly the move that loses it.
--
-- The 30 open fn_ca_escrow_vs_counter_check rows are NOT touched either. That
-- detector is retired too, but its own retirement note says its open rows are
-- the epoch reset gate's list, and the epoch reset is Dan's.

BEGIN;

DO $sweep$
DECLARE
  v_abs int; v_replay int; v_kept int;
BEGIN
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: detector retired at the Phase 6.3 gate - the engine has '
                   || 'written stacks in delta mode since 2026-09-04 19:00 (PR #2958), so an '
                   || 'absolute-mode finding is impossible. Every row in this population was '
                   || 'filed before that change; the newest is 2026-09-04 10:48. Resolved by '
                   || 'migration 20260906021758.'
   WHERE source = 'drift_incident:fn_ca_settle_hand_stacks_absolute'
     AND resolved IS NOT TRUE
     AND created_at < '2026-09-04 19:00+00';
  GET DIAGNOSTICS v_abs = ROW_COUNT;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: filed by a replay run superseded by a later migration in the '
                   || 'same hour - 20260906003739 (key an account by what owns the chips), '
                   || '20260906004441 (read balances and journal at one instant) and '
                   || '20260906011716 (a residue that already cancelled is not a finding). '
                   || 'The run after the last of those judged 1,012 accounts, 0 unkeyable, and '
                   || 'filed one finding. Resolved by migration 20260906021758.'
   WHERE source = 'drift_incident:fn_ca_ledger_replay'
     AND resolved IS NOT TRUE
     AND created_at < '2026-09-06 01:20+00';
  GET DIAGNOSTICS v_replay = ROW_COUNT;

  -- The felt finding must survive this sweep.
  SELECT count(*) INTO v_kept FROM public.financial_alerts
   WHERE source = 'drift_incident:fn_ca_ledger_replay' AND resolved IS NOT TRUE;
  IF v_kept <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 replay finding left open (the felt), found %', v_kept;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_alerts
     WHERE source = 'drift_incident:fn_ca_ledger_replay' AND resolved IS NOT TRUE
       AND context->>'account_key' LIKE 'table_stack:%') THEN
    RAISE EXCEPTION 'the one surviving replay finding is not the felt';
  END IF;

  -- And the epoch reset gate's list is untouched.
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE source = 'drift_incident:fn_ca_escrow_vs_counter_check'
         AND resolved IS NOT TRUE) < 25 THEN
    RAISE EXCEPTION 'the escrow counter rows were swept and they are the reset gate''s list';
  END IF;

  RAISE NOTICE 'BOARD_SWEPT: % absolute-mode, % superseded replay, 1 felt finding kept', v_abs, v_replay;
END $sweep$;

COMMIT;
