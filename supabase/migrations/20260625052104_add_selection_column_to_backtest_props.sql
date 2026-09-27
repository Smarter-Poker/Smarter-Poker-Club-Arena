-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260625052104 "add_selection_column_to_backtest_props"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3d284f928682292bf4635bf597feb103 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

ALTER TABLE backtest_props ADD COLUMN IF NOT EXISTS selection TEXT;
