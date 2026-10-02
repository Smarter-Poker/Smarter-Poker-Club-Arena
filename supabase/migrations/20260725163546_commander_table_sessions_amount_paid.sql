-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725163546 "commander_table_sessions_amount_paid"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 925d805224fec600d3f6279511e91a3f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander audit 2026-07-25: time-billing payment recording writes
-- commander_table_sessions.amount_paid, which did not exist (every payment
-- update failed). Additive column only.
alter table public.commander_table_sessions
  add column if not exists amount_paid numeric(10,2) not null default 0;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='commander_table_sessions' and column_name='amount_paid') then
    raise exception 'amount_paid was not created';
  end if;
end $$;
