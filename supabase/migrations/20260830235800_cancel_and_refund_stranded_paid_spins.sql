-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830235800; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- 20260830111000_cancel_and_refund_stranded_paid_spins.sql
-- TIER: 3 | AFFECTS: three stranded spins with PAID entrants and all tables
-- closed (b5ee9c99, 3f4f95d5, fc92c7d5). Their buy-in debits total 25.00
-- with zero refunds; the games can never run (only table closed while
-- REGISTERING - the fn_sync bug fixed in the previous migration hid them).
-- atomic_cancel_tournament is the sanctioned path: it refunds every entrant
-- (horses identically to humans) and reverses fees.
-- ROLLBACK: none - a cancelled, refunded game must stay cancelled; the
-- ledger rows are the audit trail.
-- ============================================================================
DO $$
DECLARE
  g record; res jsonb; v_ok int := 0; v_fail int := 0;
BEGIN
  FOR g IN
    SELECT t.id FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND EXISTS (SELECT 1 FROM public.tables tb WHERE tb.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tables tb
                        WHERE tb.tournament_id = t.id
                          AND lower(COALESCE(tb.status,'')) <> 'closed')
  LOOP
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_ok := v_ok + 1;
      RAISE NOTICE 'cancelled stranded paid spin %: %', g.id, res;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
      RAISE WARNING 'could not cancel stranded spin %: %', g.id, SQLERRM;
    END;
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;
  RAISE NOTICE 'stranded paid spins: % cancelled, % failed', v_ok, v_fail;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'stranded spin cancellation failed for % game(s) - investigate before rerunning', v_fail;
  END IF;
END $$;
