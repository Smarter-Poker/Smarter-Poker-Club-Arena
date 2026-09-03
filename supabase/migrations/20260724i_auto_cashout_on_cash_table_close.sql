-- ═══════════════════════════════════════════════════════════════════════════════
--  MONEY FIX — Auto cash-out real players when a CASH table closes
-- ═══════════════════════════════════════════════════════════════════════════════
--  Applied to production (kuklfnapbkmacvwxktbh) 2026-07-24.
--
--  BUG: several code paths set tables.status='closed' (startup sweep, cleanup,
--  break-table teardown, etc.). Only cleanupStaleData cashed out seated cash
--  players first; the others closed the table with players still seated, so their
--  chips were never returned to their wallets. This stranded 127 real players
--  holding 39,901.69 chips on closed cash tables.
--
--  ONE-TIME RECONCILIATION (run 2026-07-24, recorded here for the audit trail):
--    For every stuck seat (cash table, status closed/cancelled, left_at IS NULL,
--    stack>0, real user with a buyin and NO existing cashout) we called
--    atomic_table_cashout(user_id, table_id, seat_number). Verified: 127 seats,
--    39,901.69 chips returned via normal 'cashout' wallet_transactions, 0 remaining.
--    (Data operation — not re-run by this migration; idempotent anyway since the
--    seats now have left_at set.)
--
--  DURABLE FIX (below): a trigger that guarantees the cashout on EVERY close path.
--  Fires only on the transition INTO a terminal status for a CASH table. Each
--  still-seated REAL player (left_at IS NULL, horse_id IS NULL, stack>0) is cashed
--  out via atomic_table_cashout (credits PLAYER wallet, logs 'cashout', sets
--  left_at). Horses are skipped. No recursion: atomic_table_cashout's internal
--  `UPDATE tables SET current_players` does not change status, so the WHEN guard is
--  false on the recursive fire. A per-seat failure warns but never aborts the close.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN
    RETURN NEW; -- tournament tables settle via prizes, not seat cashout
  END IF;

  FOR r IN
    SELECT ts.user_id, ts.seat_number
    FROM table_seats ts
    WHERE ts.table_id = NEW.id
      AND ts.left_at IS NULL
      AND ts.horse_id IS NULL
      AND COALESCE(ts.stack,0) > 0
  LOOP
    BEGIN
      PERFORM public.atomic_table_cashout(r.user_id, NEW.id, r.seat_number);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'auto-cashout failed for user % on table %: %', r.user_id, NEW.id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tables_auto_cashout_on_close ON public.tables;
CREATE TRIGGER trg_tables_auto_cashout_on_close
  AFTER UPDATE OF status ON public.tables
  FOR EACH ROW
  WHEN (
    NEW.status IS DISTINCT FROM OLD.status
    AND lower(COALESCE(NEW.status,'')) IN ('closed','completed','cancelled','finished')
  )
  EXECUTE FUNCTION public.trg_auto_cashout_on_table_close();
