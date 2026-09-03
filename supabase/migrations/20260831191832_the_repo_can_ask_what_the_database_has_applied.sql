-- ===========================================================================
-- THE REPO CAN ASK WHAT THE DATABASE HAS APPLIED (2026-08-31)
--
-- check-migrations-applied.mjs asks one direction: does every migration THIS
-- BRANCH ADDS exist in the live schema. Nothing has ever asked the other
-- direction - which applied migrations have NO FILE IN THE REPO.
--
-- Measured today, and it is not a rounding error:
--
--   90 migrations applied since 14:00 UTC
--   41 of them had no file on origin/main
--
-- Among them were all 13 of the zero-drift ledger-hardening migrations, which
-- sat unrecorded for hours because that session's GitHub token was refused and
-- nothing anywhere noticed the repo had stopped matching the database. On the
-- day Midway Union is rebuilt from these files, an unrecorded migration is a
-- feature the database has and the rebuild does not.
--
-- PostgREST does not expose the `supabase_migrations` schema, so a CI script
-- cannot read it directly. This is the narrow door: version and name only,
-- never `statements` (which contain the full DDL and occasionally literals),
-- bounded by a caller-supplied floor.
--
-- Closed to the browser in the same migration - it is operator telemetry, and
-- phase 3's rule stands.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'PRE-FLIGHT: supabase_migrations.schema_migrations is missing';
  end if;
end $$;

-- THE CHANGE
create or replace function public.fn_ca_applied_migrations(p_since text default null)
returns table(version text, name text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  -- version and name ONLY. `statements` is deliberately not returned: it is the
  -- full DDL of every migration ever applied and this function exists to be
  -- called by CI, not to hand the schema's history to whoever asks.
  select m.version, m.name
    from supabase_migrations.schema_migrations m
   where m.version ~ '^[0-9]+$'
     and (p_since is null or m.version >= p_since)
   order by m.version;
$function$;

revoke all on function public.fn_ca_applied_migrations(text) from public, anon, authenticated;
grant execute on function public.fn_ca_applied_migrations(text) to service_role;

-- POST-APPLY: BOTH HALVES
do $$
declare v_all bigint; v_since bigint;
begin
  -- HALF ONE: it answers, and the bound works.
  select count(*) into v_all   from public.fn_ca_applied_migrations();
  select count(*) into v_since from public.fn_ca_applied_migrations('20260831140000');
  if v_all = 0 then
    raise exception 'POST-APPLY: the function returned no migrations at all';
  end if;
  if v_since >= v_all then
    raise exception 'POST-APPLY: the p_since bound did not narrow anything (% since vs % total)', v_since, v_all;
  end if;

  -- ...and it never hands back the DDL.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'fn_ca_applied_migrations'
       and column_name = 'statements'
  ) then
    raise exception 'POST-APPLY: the function exposes statements';
  end if;

  -- HALF TWO: the browser cannot call it, and CI can.
  if has_function_privilege('anon', 'public.fn_ca_applied_migrations(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_ca_applied_migrations(text)', 'EXECUTE') then
    raise exception 'POST-APPLY: a browser role can still execute it';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_applied_migrations(text)', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role cannot execute it, so CI could not call it';
  end if;

  raise notice 'POST-APPLY: % migrations visible, % since the 2026-08-31 14:00 floor', v_all, v_since;
end $$;

commit;

-- ===========================================================================
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_ca_applied_migrations(text);
--
-- The repo then has no way to ask what the database has applied, which is the
-- state that let 41 migrations go unrecorded.
-- ===========================================================================
