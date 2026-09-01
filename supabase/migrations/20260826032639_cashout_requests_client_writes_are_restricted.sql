-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826032639; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cashout_requests' and c.relrowsecurity
  ) then
    raise exception 'cashout_requests does not have RLS enabled; a restrictive policy would be decoration';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cashout_requests' and c.relforcerowsecurity
  ) then
    raise exception 'cashout_requests has force_rls ON; the SECURITY DEFINER cashout RPCs would be blocked by this migration';
  end if;
end $$;

drop policy if exists "cashout_no_client_insert" on public.cashout_requests;
drop policy if exists "cashout_no_client_update" on public.cashout_requests;
drop policy if exists "cashout_no_client_delete" on public.cashout_requests;

create policy "cashout_no_client_insert" on public.cashout_requests
  as restrictive for insert to anon, authenticated
  with check (false);

create policy "cashout_no_client_update" on public.cashout_requests
  as restrictive for update to anon, authenticated
  using (false) with check (false);

create policy "cashout_no_client_delete" on public.cashout_requests
  as restrictive for delete to anon, authenticated
  using (false);

comment on table public.cashout_requests is
  'Player cashout queue. Client writes are barred by three RESTRICTIVE policies; '
  'the only write paths are fn_cashout_request / fn_cashout_approve / '
  'fn_cashout_release (SECURITY DEFINER) and service_role. Reads are scoped by '
  'cashout_read_scoped.';

do $$
declare
  n_restrictive int;
  n_select      int;
begin
  select count(*) into n_restrictive
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'cashout_requests'
     and not p.polpermissive;
  if n_restrictive <> 3 then
    raise exception 'expected 3 restrictive policies on cashout_requests, found %', n_restrictive;
  end if;

  select count(*) into n_select
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'cashout_requests'
     and p.polcmd = 'r' and p.polpermissive;
  if n_select < 1 then
    raise exception 'the permissive SELECT policy on cashout_requests is missing; staff would see an empty queue';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fn_cashout_request', 'fn_cashout_approve', 'fn_cashout_release')
       and not p.prosecdef
  ) then
    raise exception 'a client-callable cashout RPC is SECURITY INVOKER; it would now be blocked';
  end if;
end $$;
