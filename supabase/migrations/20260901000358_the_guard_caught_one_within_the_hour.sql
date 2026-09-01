-- ===========================================================================
-- THE GUARD CAUGHT ONE WITHIN THE HOUR (2026-09-01)
--
-- fn_ca_browser_reachable_telemetry() shipped at 23:13 UTC. Its first real run
-- in CI, at 00:02, went red on a function that did not exist when the guard was
-- written:
--
--   fn_ca_migration_text                     stable    anon + authenticated
--                                            (p_version text)
--
-- It returns THE FULL SQL TEXT OF ANY APPLIED MIGRATION, by version, to anyone
-- - including a visitor with no account. Every migration this platform has ever
-- run: the money paths, the fraud rules, the security fixes, and the comments
-- explaining what each one was defending against.
--
-- ---------------------------------------------------------------------------
-- THE AUTHOR MEANT TO CLOSE IT. THE DATABASE OVERRULED THEM.
--
-- Its own COMMENT, written by the agent who created it, reads:
--
--   "The exact statements a migration executed, with an md5, so a committed
--    file can be PROVEN identical to what production ran instead of
--    reconstructed by hand. Read-only, SERVICE_ROLE ONLY."
--
-- service_role only. That is what it says, and it is what the author believed.
-- Postgres grants EXECUTE to PUBLIC on every new function, Supabase publishes
-- it as an RPC, and nobody wrote the REVOKE - so the function was anon-readable
-- from the moment it was created, while its documentation said otherwise.
--
-- This is the fourth recorded instance of that exact default doing that exact
-- thing on this estate, and the first one caught by a machine instead of by a
-- person going looking. It was built in response to last night's finding that
-- 428 applied migrations have no file in the repo - a good tool, born public.
--
-- Zero callers in club-arena (src, server/src, scripts, .github) or the World
-- Hub. It has no repo file of its own yet either, which is the same 428 problem
-- it was written to solve.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_ca_migration_text' and p.prosecdef) then
    raise exception 'PRE-FLIGHT: fn_ca_migration_text is not present as SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'fn_ca_migration_text'
                    and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'PRE-FLIGHT: it is already closed to anon - somebody got there first';
  end if;
end $$;

-- THE CHANGE
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_ca_migration_text'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_txt   text;
  v_guard bigint;
begin
  -- HALF ONE: no browser role reaches it, and the guard that found it agrees.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'fn_ca_migration_text'
                and (has_function_privilege('anon', p.oid, 'EXECUTE')
                  or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) then
    raise exception 'POST-APPLY: fn_ca_migration_text is still browser-reachable';
  end if;

  select count(*) into v_guard from public.fn_ca_browser_reachable_telemetry();
  if v_guard <> 0 then
    raise exception 'POST-APPLY: the guard still reports % unaccounted routine(s)', v_guard;
  end if;

  -- HALF TWO: the tool still WORKS for the people it was built for, asserted by
  -- calling it rather than by reading a grant. It is the thing that lets a
  -- committed migration file be proven identical to what production ran, and
  -- this migration would be self-defeating if it broke that.
  select statements into v_txt
    from (select array_to_string(m.statements, E';\n') as statements
            from supabase_migrations.schema_migrations m
           where m.version = '20260831231356') s;
  if v_txt is null or position('fn_ca_browser_reachable_telemetry' in v_txt) = 0 then
    raise exception 'POST-APPLY: the migration history is not readable by service_role any more';
  end if;

  perform 1 from public.fn_ca_migration_text('20260831231356');
  raise notice 'POST-APPLY: closed to browsers, still readable by service_role';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - republishes every migration this platform has ever run:
--   GRANT EXECUTE ON FUNCTION public.fn_ca_migration_text(text) TO anon, authenticated;
-- ===========================================================================
