-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830201953; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- V31 tables inherited the project's default grants, which include SELECT for
-- anon and authenticated. RLS is enabled with zero policies on all of them, so
-- nothing is readable through PostgREST today - but the V30 precedent,
-- gto_postflop_compact, grants SELECT only to postgres and service_role, and
-- these tables should match it rather than rely on RLS alone.
--
-- It matters because gto_postflop_v31 IS the horses' strategy: the solver mix
-- each hand class plays on each texture. One permissive policy added later, or
-- RLS switched off during unrelated debugging, and a player could read the
-- fleet's exact frequencies. Defence in depth costs nothing here: only the
-- engine (service_role) ever reads these.

revoke all on public.gto_postflop_v31     from anon, authenticated;
revoke all on public.gto_agg_progress_v31 from anon, authenticated;
revoke all on public.gto_combo_map        from anon, authenticated;

grant select, insert, update on public.gto_postflop_v31     to service_role;
grant select, insert, update on public.gto_agg_progress_v31 to service_role;
grant select                 on public.gto_combo_map        to service_role;

do $$
declare v_n integer; v_rls boolean; v_t text;
begin
  foreach v_t in array array['gto_postflop_v31','gto_agg_progress_v31','gto_combo_map'] loop
    select count(*) into v_n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = v_t
       and grantee in ('anon', 'authenticated');
    if v_n <> 0 then
      raise exception '% still grants % privilege(s) to anon/authenticated', v_t, v_n;
    end if;

    select c.relrowsecurity into v_rls from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_t;
    if not coalesce(v_rls, false) then
      raise exception '% does not have row level security enabled', v_t;
    end if;

    -- service_role must still be able to read, or the engine goes blind
    select count(*) into v_n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = v_t
       and grantee = 'service_role' and privilege_type = 'SELECT';
    if v_n = 0 then
      raise exception '% no longer grants SELECT to service_role', v_t;
    end if;
  end loop;
end $$;
