-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828221437; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  CLOSE THE ALERTS THE RECONCILER HAS SINCE ANSWERED (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_tournament_payout_reconcile` files a CRITICAL financial_alert whenever it
-- cannot fully reconcile an event, and nothing ever closes one. Two reasons the
-- open list is now stale:
--
--   * the 20,062.50 of genuinely unpaid places was paid today, so those events
--     reconcile clean;
--   * the reconciler itself was counting corrective DEBITS as payments until
--     migration ..._reconcile_counts_a_debit_as_a_debit, so some of these
--     alerts were never real - Union PKO Afternoon 4f42d847 raised one on a
--     ledger that balances to the cent.
--
-- An alert list nobody can trust is worse than no alert list: the next person
-- to look at a genuine critical has to wade through answered ones first. So
-- each open alert is RE-ASKED rather than blanket-cleared, and only the ones
-- that now come back `clean` are closed. Anything still unreconciled stays
-- open, loudly, exactly as it should.
--
-- ROLLBACK: UPDATE financial_alerts SET resolved = false, resolved_at = NULL
--           WHERE source = 'fn_tournament_payout_reconcile'
--             AND resolved_at = <this migration's timestamp>;

DO $$
DECLARE
  v_open      int;
  v_closed    int;
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_open
    FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile'
     AND COALESCE(resolved, false) = false;

  WITH open_alerts AS (
    SELECT id, (context->>'tournament_id')::uuid AS tid
      FROM financial_alerts
     WHERE source = 'fn_tournament_payout_reconcile'
       AND COALESCE(resolved, false) = false
       AND context->>'tournament_id' IS NOT NULL
  ),
  rechecked AS (
    SELECT id, tid, fn_tournament_payout_reconcile(tid, false) AS r
      FROM open_alerts
  )
  UPDATE financial_alerts fa
     SET resolved = true,
         resolved_at = now()
    FROM rechecked
   WHERE fa.id = rechecked.id
     AND COALESCE((rechecked.r->>'clean')::boolean, false) = true;

  GET DIAGNOSTICS v_closed = ROW_COUNT;

  SELECT count(*) INTO v_remaining
    FROM financial_alerts
   WHERE source = 'fn_tournament_payout_reconcile'
     AND COALESCE(resolved, false) = false;

  RAISE NOTICE 'payout alerts: % open before, % closed as reconciled, % still open',
    v_open, v_closed, v_remaining;
END $$;
