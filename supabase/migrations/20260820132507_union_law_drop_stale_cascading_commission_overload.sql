-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132507 "union_law_drop_stale_cascading_commission_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d40341e2bf19d036a000dfcdc5a0db8f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Adding p_table_id created a SECOND calculate_cascading_commission rather than
-- replacing the first. The engine posts five arguments, so it would have kept
-- hitting the OLD one — which books commission against the table's club (now
-- always the Midway house club, where no agent links exist) and would have left
-- the agent economy dead despite the fix. Same overload trap as the buy-in
-- path; drop the stale signature so one implementation serves every caller
-- (p_table_id simply defaults to NULL, and the resolver then falls back to the
-- player's member club).
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid);

