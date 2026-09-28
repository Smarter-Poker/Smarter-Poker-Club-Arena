-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909233948; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909233948   (the stamp IS the apply time, UTC: 2026-09-09 23:39:48)
--   name        ca_a_move_to_a_closed_table_is_cancelled_not_thrown
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4130 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909233948 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        zz_cancel_cash_seat_moves_on_table_close
--     FUNCTION       public.fn_cancel_cash_seat_moves_on_table_close
--     DROP           TRIGGER zz_cancel_cash_seat_moves_on_table_close
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ca_a_move_to_a_closed_table_is_cancelled_not_thrown
--
-- 2026-09-09 22:50-23:04, NLH 0.25/0.50 Classic (cluster e942e4c1): the
-- planner moved players toward the Feeder 7323cc31 and the cluster broke
-- that feeder in the same tick. fn_cash_seat_move_execute checks that both
-- tables are cash tables of the move's game with an open admission key and,
-- finding the destination's key 'closed', raised SEAT_MOVE_GAME_SCOPE_MISMATCH.
-- The engine executes pending moves in postHandTasks.leave_pending at every
-- hand boundary until the move expires, so one planned-then-broken
-- destination raised the same exception fifteen times in three minutes
-- (drift incident e93de6ea) and the move only stopped when its window
-- expired ("engine_did_not_execute_before_expiry").
--
-- A table that closed after the move was planned is not a scope error. It is
-- a move that can no longer happen, exactly like a source occupancy that has
-- gone, and it is answered the same way: the move (and its swap partner) is
-- cancelled with a note and the engine is told why. The scope exception
-- stays for what it was written for: a table whose cluster no longer matches
-- the move's game (CashoutDeparturePostgres.test.ts pins it).
--
-- And the planner's own break step now cancels the moves it just made
-- impossible: closing a table cancels every pending move that names it, so
-- the engine never picks one up.

BEGIN;

DO $patch$
DECLARE
  v_def text;
  v_anchor text := '-- A legacy empty cash destination initializes its derived key inside the';
  v_patch text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_seat_move_execute'::regproc);
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_cash_seat_move_execute: anchor not found, refusing to patch blind';
  END IF;
  IF position('''table_closed''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'fn_cash_seat_move_execute: already carries the closed-table branch';
  END IF;
  v_patch := $p$ -- 2026-09-09: a table that closed after the move was planned is not a
 -- scope error, it is a move that can no longer happen. Cancel it like a
 -- source occupancy that has gone, and tell the engine why.
 IF EXISTS(SELECT 1 FROM public.tables
    WHERE id IN(m.from_table_id,m.to_table_id,pm.from_table_id,pm.to_table_id)
      AND (status='closed' OR seat_admission_key='closed')) THEN
  UPDATE public.cash_seat_moves SET state='cancelled',note='table_closed'
   WHERE id IN(m.id,pm.id) AND state='pending';
  RETURN jsonb_build_object('ok',false,'reason','table_closed','move_id',m.id,
    'player_id',m.player_id,'from_table_id',m.from_table_id,'to_table_id',m.to_table_id,
    'source_occupancy_id',m.source_occupancy_id,'source_seat_number',m.source_seat_number);
 END IF;
$p$;
  v_def := replace(v_def, v_anchor, v_patch || E'\n' || v_anchor);
  EXECUTE v_def;
END
$patch$;

CREATE OR REPLACE FUNCTION public.fn_cancel_cash_seat_moves_on_table_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (NEW.seat_admission_key = 'closed' AND OLD.seat_admission_key IS DISTINCT FROM 'closed') THEN
    -- the moves that name this table, and the swap partners of those moves
    UPDATE public.cash_seat_moves m
       SET state = 'cancelled', note = 'table_closed'
     WHERE m.state = 'pending'
       AND (m.from_table_id = NEW.id OR m.to_table_id = NEW.id
            OR EXISTS (SELECT 1 FROM public.cash_seat_moves p
                        WHERE p.id = m.swap_move_id AND p.state = 'pending'
                          AND (p.from_table_id = NEW.id OR p.to_table_id = NEW.id)));
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cancel_cash_seat_moves_on_table_close() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_cancel_cash_seat_moves_on_table_close ON public.tables;
CREATE TRIGGER zz_cancel_cash_seat_moves_on_table_close
  AFTER UPDATE OF status, seat_admission_key ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_cancel_cash_seat_moves_on_table_close();

COMMIT;
