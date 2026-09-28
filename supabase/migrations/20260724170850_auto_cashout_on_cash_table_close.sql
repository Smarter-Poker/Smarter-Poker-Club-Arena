-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260724170850 as "auto_cashout_on_cash_table_close"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- DURABLE FIX: guarantee no real player is ever stranded (chips un-returned) when a
-- CASH table closes. Multiple code paths set tables.status='closed' and not all of
-- them cash out still-seated players first, which left 127 players holding ~39.9K
-- chips on closed tables (reconciled separately). This centralizes the guarantee at
-- the DB layer so EVERY close path is covered, regardless of which code set the status.
--
-- Fires only on the transition INTO a terminal status for a CASH table (tournament_id
-- IS NULL). For each still-seated REAL player (left_at IS NULL, horse_id IS NULL,
-- stack>0) it runs the normal cashout (atomic_table_cashout) which credits the PLAYER
-- wallet, writes a 'cashout' wallet_transaction, and sets left_at. Horses are skipped
-- (bots have no real wallet to settle). No infinite recursion: atomic_table_cashout's
-- internal `UPDATE tables SET current_players` does not change status, so the WHEN
-- guard (status actually changed) is false on the recursive fire.

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
      -- Never block the close on a single seat's cashout failure; leave that seat
      -- for the reconciliation sweep rather than aborting the whole transaction.
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
