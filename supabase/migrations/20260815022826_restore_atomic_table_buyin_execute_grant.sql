-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815022826 "restore_atomic_table_buyin_execute_grant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 95dcc76d6841e463a39acf7f7eea6ec3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- P0 fix (2026-08-15, live E2E): every human buy-in at Club Arena tables was
-- failing with 42501 "permission denied for function atomic_table_buyin" —
-- the client calls this RPC as the authenticated role, but the function's ACL
-- only listed postgres + service_role (grant lost, likely when a migration
-- recreated the function). Horses are seeded via service_role, which is why
-- bot stacks still worked while every human sat down with 0 chips.
-- The function is SECURITY INVOKER and every table it touches (wallets,
-- table_seats, tables, blacklists) has RLS enabled, so caller policies still
-- bind all reads/writes; it also enforces min/max buy-in and club/union bans
-- server-side.
GRANT EXECUTE ON FUNCTION public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean) TO authenticated;
