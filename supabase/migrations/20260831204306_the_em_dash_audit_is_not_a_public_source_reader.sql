-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831204306; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

begin;

do $$
begin
  if to_regprocedure('public.fn_ca_banned_copy_characters()') is null then
    raise exception 'PRE-FLIGHT: public.fn_ca_banned_copy_characters() does not exist';
  end if;
end $$;

revoke all on function public.fn_ca_banned_copy_characters() from public, anon, authenticated;
grant execute on function public.fn_ca_banned_copy_characters() to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: anon can still execute the source reader';
  end if;
  if has_function_privilege('authenticated', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: authenticated can still execute the source reader';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_banned_copy_characters()', 'EXECUTE') then
    raise exception 'VERIFY: service_role lost the telemetry it needs';
  end if;
end $$;

commit;
