-- ===========================================================================
-- A SIGNUP IS NOT A MOVEMENT IN THE DEAD WALLET POOL (2026-08-31)
--
-- fn_chip_integrity_report()'s `legacy_wallets_frozen` check had been reporting
-- CRITICAL, and it was wrong. Measured:
--
--   public.wallets                       1,856 rows
--   sum(balance)                    732,591,994.33   <- the frozen figure in
--                                                       CLAUDE.md section 11.5,
--                                                       unchanged
--   rows with balance <> 0                 690
--   last write to a NON-ZERO row   2026-08-20 23:45:28Z
--   writes in the last 36 hours              3       <- all balance 0.00, all
--                                                       created_at = updated_at,
--                                                       all brand-new profiles
--
-- The pool has not moved since it was frozen. What HAS happened is that new
-- signups still get an empty row in the dead table, and the check read
-- `max(updated_at)` across every row - so one signup turned the whole report
-- critical for two days. With signups arriving daily that is a PERMANENT red.
--
-- A permanently red critical on the one report that exists to make chip loss
-- LOUD is worse than no report: it teaches everybody to scroll past the line
-- that will one day be true.
--
-- ---------------------------------------------------------------------------
-- WHAT "NEWS" ACTUALLY MEANS HERE
--
-- Two things, and the old check caught neither reliably:
--
--   1. THE TOTAL CHANGED. Chips entered or left the dead pool. Exact, needs no
--      timestamp, and cannot be faked by a row appearing at 0.00.
--   2. A ROW THAT HOLDS CHIPS WAS TOUCHED. Covers a credit into an existing
--      balance even in the freak case where the total happens to net out.
--
-- Either is critical. A zero-balance row created at signup is neither.
--
-- ---------------------------------------------------------------------------
-- HOW THIS IS EDITED
--
-- By string replacement against pg_get_functiondef(), not by retyping the
-- function. The other six checks in that report are somebody else's work and
-- are none of this migration's business; retyping them by hand is how a
-- transcription slip becomes a silent regression in a money report. Each
-- replacement asserts it actually changed something, so a drifted source aborts
-- the migration rather than applying a partial edit.
--
-- ---------------------------------------------------------------------------
-- TWO THINGS THAT HAPPENED WHILE APPLYING THIS, RECORDED BECAUSE THEY WILL
-- HAPPEN AGAIN TO SOMEBODY ELSE
--
-- 1. THE CLIENT TIMED OUT AND THE SERVER COMMITTED ANYWAY. The post-apply block
--    below calls fn_chip_integrity_report() four times, and that report runs
--    fn_unaccounted_seat_exits() over 7 days (~8.5s), so the call exceeded the
--    60s client budget. The MCP reported a timeout; Postgres finished and
--    COMMITTED. A verification query run immediately afterwards still saw the
--    old body and said "not applied" - it had raced the commit.
--
--    So: after a timed-out apply, verify twice with a pause before concluding
--    anything, and never re-run on the strength of a single negative check.
--    Written as ONE aggregated call would have avoided it entirely:
--
--      SELECT jsonb_object_agg(r.check_name, r.severity), count(*)
--        INTO v_map, v_rows FROM public.fn_chip_integrity_report() r;
--
-- 2. THE RETRY REFUSED ITSELF, WHICH IS THE POINT. Believing the negative
--    check, a second attempt was made. It aborted on its own EDIT 1 assertion -
--    "matched nothing... has drifted" - because the edits were already there.
--    The assertion that exists to catch a drifted source also made a
--    double-apply impossible. Nothing was applied twice and nothing was left
--    half done.
-- ===========================================================================

begin;

do $mig$
DECLARE
  v_def    text;
  v_new    text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_chip_integrity_report';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_chip_integrity_report does not exist';
  END IF;

  -- The pool really is frozen at the documented figure. If it is not, the check
  -- is telling the truth and this migration must not silence it.
  IF (SELECT round(COALESCE(sum(balance), 0), 2) FROM public.wallets) <> 732591994.33 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: public.wallets no longer sums to 732591994.33 - the alarm is RIGHT, do not quiet it';
  END IF;

  IF (SELECT max(updated_at) FROM public.wallets WHERE balance <> 0) > now() - interval '2 days' THEN
    RAISE EXCEPTION 'PRE-FLIGHT: a row holding chips was written in the last 2 days - the alarm is RIGHT, do not quiet it';
  END IF;

  v_new := v_def;

  -- 1. Only a row that holds chips counts as a money write.
  v_before := v_new;
  v_new := replace(
    v_new,
    'max(updated_at) INTO v_frozen, v_last_write FROM public.wallets;',
    'max(updated_at) FILTER (WHERE balance <> 0) INTO v_frozen, v_last_write FROM public.wallets;'
  );
  IF v_new = v_before THEN
    RAISE EXCEPTION 'EDIT 1 matched nothing - fn_chip_integrity_report has drifted; re-read it before editing';
  END IF;

  -- 2. A changed TOTAL is news on its own, with or without a recent timestamp.
  v_before := v_new;
  v_new := replace(
    v_new,
    'severity   := CASE WHEN v_last_write > now() - interval ''2 days'' THEN ''critical'' ELSE ''ok'' END;',
    'severity   := CASE'
      || ' WHEN round(v_frozen, 2) <> 732591994.33 THEN ''critical'''
      || ' WHEN v_last_write > now() - interval ''2 days'' THEN ''critical'''
      || ' ELSE ''ok'' END;'
  );
  IF v_new = v_before THEN
    RAISE EXCEPTION 'EDIT 2 matched nothing - fn_chip_integrity_report has drifted; re-read it before editing';
  END IF;

  -- 3. Say what is actually being watched.
  v_before := v_new;
  v_new := replace(
    v_new,
    'public.wallets holds %s chips, last written %s. Dead pool; only a NEW write is news.',
    'public.wallets holds %s chips, last MONEY write %s. Dead pool frozen at 732591994.33; '
      || 'a zero-balance row created at signup is not a movement, a changed total is.'
  );
  IF v_new = v_before THEN
    RAISE EXCEPTION 'EDIT 3 matched nothing - fn_chip_integrity_report has drifted; re-read it before editing';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- POST-APPLY: BOTH HALVES
do $post$
DECLARE
  v_rows bigint;
  v_sev  text;
BEGIN
  -- HALF ONE: the report still returns every check it used to, and the one
  -- this migration touched is no longer crying wolf.
  SELECT count(*) INTO v_rows FROM public.fn_chip_integrity_report();
  IF v_rows < 7 THEN
    RAISE EXCEPTION 'POST-APPLY: the report returned only % check(s); it used to return 7', v_rows;
  END IF;

  SELECT r.severity INTO v_sev
    FROM public.fn_chip_integrity_report() r
   WHERE r.check_name = 'legacy_wallets_frozen';
  IF v_sev IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: the legacy_wallets_frozen check has vanished from the report';
  END IF;
  IF v_sev <> 'ok' THEN
    RAISE EXCEPTION 'POST-APPLY: legacy_wallets_frozen is still %, with the pool provably unmoved', v_sev;
  END IF;

  -- HALF TWO: the promise NOT to break anything. The other checks still run.
  IF NOT EXISTS (SELECT 1 FROM public.fn_chip_integrity_report() r
                  WHERE r.check_name = 'unaccounted_seat_exits') THEN
    RAISE EXCEPTION 'POST-APPLY: the unaccounted_seat_exits check has gone missing from the report';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_chip_integrity_report() r
                  WHERE r.check_name = 'ledger_liveness') THEN
    RAISE EXCEPTION 'POST-APPLY: the ledger_liveness check has gone missing from the report';
  END IF;

  RAISE NOTICE 'POST-APPLY: report returns % checks, legacy_wallets_frozen = ok', v_rows;
END
$post$;

commit;

-- ===========================================================================
-- ROLLBACK
--
-- Restores the old severity line, which turns the report critical again on the
-- next signup:
--
--   severity := CASE WHEN v_last_write > now() - interval '2 days'
--                    THEN 'critical' ELSE 'ok' END;
--
-- and drops the `FILTER (WHERE balance <> 0)` from the SELECT above it.
-- ===========================================================================
