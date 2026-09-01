-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830054324; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc
   where proname = 'fn_aggregate_gto_street_next'
     and pronamespace = 'public'::regnamespace;

  if v_src is null then
    raise exception 'fn_aggregate_gto_street_next is missing - nothing to patch';
  end if;

  if position('greatest(25, least(5000' in v_src) > 0 then
    raise notice 'batch floor already 25 - nothing to do';
    return;
  end if;

  if position('greatest(200, least(5000' in v_src) = 0 then
    raise exception
      'clamp is neither greatest(25,...) nor greatest(200,...) - aborting rather than guessing';
  end if;

  execute format(
    'create or replace function public.fn_aggregate_gto_street_next('
    'p_street text, p_batch integer default 1500) '
    'returns table (processed integer, new_last_id uuid, street_done boolean) '
    'language plpgsql security definer set search_path = public as %L',
    replace(v_src, 'greatest(200, least(5000', 'greatest(25, least(5000'));
end $$;

do $$
declare v_clamp text;
begin
  select substring(prosrc from 'v_batch integer :=[^;]+;') into v_clamp
    from pg_proc
   where proname = 'fn_aggregate_gto_street_next'
     and pronamespace = 'public'::regnamespace;
  if v_clamp not like '%greatest(25,%' then
    raise exception 'batch floor is not 25 after patching: %', v_clamp;
  end if;
end $$;
