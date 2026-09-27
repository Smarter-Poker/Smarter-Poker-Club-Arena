-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260822195438 "index_rake_records_table_global_hand"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6fe9e57a8004423d827bbba512e6c201 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- feeAlreadyBanked() falls back to (table_id, global_hand_id) whenever the
-- alert carries no hand_id — which is 861 of the 1,020 open FeeReconciler
-- alerts, i.e. the COMMON path, because hand_id is null in exactly the outage
-- this fires in. Only idx_rake_records_table_id existed, so every check
-- scanned one table's whole rake history. A slow query on a failure path is a
-- slow query during an outage.
--
-- Built non-concurrently and deliberately: CREATE INDEX CONCURRENTLY cannot run
-- in a transaction, and run outside one it exceeded the MCP statement timeout
-- and left an INVALID index behind (dropped). This is a two-column btree over
-- a table whose live tuple count is in the thousands; the write lock is brief.
CREATE INDEX IF NOT EXISTS idx_rake_records_table_global_hand
  ON public.rake_records (table_id, global_hand_id)
  WHERE global_hand_id IS NOT NULL;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.idx_rake_records_table_global_hand'::regclass
       AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'idx_rake_records_table_global_hand is not valid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.idx_bbj_contrib_table_hand_number'::regclass
       AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'idx_bbj_contrib_table_hand_number is missing or invalid';
  END IF;
END $assert$;
