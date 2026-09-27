-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260719213902 "cashout_single_pending_guard_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0cafad86fee5b6010ee24345610f989 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX-C2 2026-07-19 — enforce at most one PENDING cashout per player per club.
-- fn_request_cashout debits (escrows) chips then inserts a pending row in one
-- transaction; without this guard a concurrent double-request (or a retry after
-- the FIX-C1 false-failure) escrowed the balance twice into orphaned pending
-- rows. With the partial unique index, the second concurrent insert raises a
-- unique violation and the whole RPC transaction rolls back — including the
-- escrow debit — so no chips are lost. The endpoint surfaces it as 409.
CREATE UNIQUE INDEX IF NOT EXISTS cashout_requests_one_pending_per_player_uidx
  ON public.cashout_requests (club_id, player_id)
  WHERE status = 'pending';
