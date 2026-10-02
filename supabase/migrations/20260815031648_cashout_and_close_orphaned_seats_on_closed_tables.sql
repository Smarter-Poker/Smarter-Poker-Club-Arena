-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815031648 "cashout_and_close_orphaned_seats_on_closed_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb2f29a08d290c1751ed3d2d36194ceb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Data hygiene + chip conservation (2026-08-15): closed tables retained
-- seated rows (left_at NULL) — debris from the pre-recovery-sweep era when
-- busted or abandoned horses were never removed. No engine loop runs for
-- closed tables, so these rows never self-heal. Verified scope: 51 seats
-- with chips (1,059,272.08 total), ALL horses (profiles.is_horse), plus
-- zero-stack rows. Cash out chip-holding seats through the SAME path the
-- engine's markSeatAsLeft uses — atomic_credit_wallet_and_log with the
-- 'cashout:<seat.id>' idempotency key — so retries and prior partial
-- cashouts dedupe, then soft-delete every orphaned seat and sync
-- tables.current_players.

DO $$
DECLARE
  r RECORD;
  v_ok boolean;
  v_credited integer := 0;
  v_failed integer := 0;
BEGIN
  FOR r IN
    SELECT ts.id, ts.table_id, ts.user_id, ts.seat_number, ts.stack
      FROM table_seats ts
      JOIN tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND t.status = 'closed'
       AND ts.stack > 0
  LOOP
    -- Safety: only horses (verified by scope query; enforce anyway)
    IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = r.user_id AND p.is_horse) THEN
      RAISE EXCEPTION 'Seat % on table % belongs to a non-horse user — manual review required', r.id, r.table_id;
    END IF;

    v_ok := atomic_credit_wallet_and_log(
      r.user_id, r.stack, 'cashout',
      'Cash-out from closed table (orphaned seat cleanup)',
      r.table_id, NULL, NULL,
      'cashout:' || r.id
    );
    IF v_ok THEN
      UPDATE table_seats SET left_at = now(), leave_pending = false WHERE id = r.id AND left_at IS NULL;
      v_credited := v_credited + 1;
    ELSE
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Orphaned-seat cashout: % credited, % failed', v_credited, v_failed;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'Aborting: % orphaned seats failed to credit — no seats were force-closed with chips', v_failed;
  END IF;
END $$;

-- Zero-stack orphans: nothing to credit, just close them.
UPDATE table_seats ts
   SET left_at = now(), leave_pending = false
  FROM tables t
 WHERE t.id = ts.table_id
   AND ts.left_at IS NULL
   AND t.status = 'closed'
   AND ts.stack = 0;

-- Sync lobby ghost counts on closed tables.
UPDATE tables t
   SET current_players = (
     SELECT count(*) FROM table_seats ts
      WHERE ts.table_id = t.id AND ts.left_at IS NULL
   )
 WHERE t.status = 'closed'
   AND t.current_players <> (
     SELECT count(*) FROM table_seats ts
      WHERE ts.table_id = t.id AND ts.left_at IS NULL
   );
