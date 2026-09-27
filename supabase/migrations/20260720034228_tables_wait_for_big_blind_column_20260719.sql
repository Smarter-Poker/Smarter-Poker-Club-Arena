-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720034228 "tables_wait_for_big_blind_column_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f2343ce59f2935e3b643765192bc7d5a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX-D11 2026-07-19 — the engine has wait-for-BB seating logic
-- (ServerTableEngine.registerWaitForBB reads tableInfo.wait_for_big_blind) but
-- the column didn't exist on `tables` and loadTable never selected it, so the
-- setting was always undefined (new players were dealt in immediately regardless).
-- Add the column (Bible V8 §4.2 default: new players wait for the BB).
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS wait_for_big_blind boolean NOT NULL DEFAULT true;
