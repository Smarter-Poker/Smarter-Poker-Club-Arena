-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815022907 "restore_atomic_table_cashout_execute_grant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 12fe1fd89a25f64bdfbb33f4e587aace of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Companion to restore_atomic_table_buyin_execute_grant (2026-08-15 live E2E):
-- atomic_table_cashout had the same lost ACL (only postgres + service_role),
-- while its siblings atomic_table_addon / _rebuy / _withdraw all grant
-- authenticated. Without this, a player could buy in but never cash out —
-- chips would strand at the table. SECURITY INVOKER + RLS on table_seats and
-- wallets bind the caller's policies on every read/write.
GRANT EXECUTE ON FUNCTION public.atomic_table_cashout(uuid, uuid, integer) TO authenticated;
