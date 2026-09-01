-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831204456; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

begin;

do $$
begin
  if to_regprocedure('public.fn_collect_bounty(uuid, uuid, uuid, jsonb)') is null then
    raise exception 'PRE-FLIGHT: fn_collect_bounty(uuid, uuid, uuid, jsonb) does not exist';
  end if;
  if not has_function_privilege(
    'service_role', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'PRE-FLIGHT: service_role cannot execute it, so the engine would break';
  end if;
end $$;

revoke all on function public.fn_collect_bounty(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_collect_bounty(uuid, uuid, uuid, jsonb)
  to service_role;

do $$
begin
  if has_function_privilege(
    'anon', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: anon can still pay a bounty';
  end if;
  if has_function_privilege(
    'authenticated', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: a logged-in player can still name themselves the collector';
  end if;
  if not has_function_privilege(
    'service_role', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: the engine lost the grant it needs to pay bounties';
  end if;
end $$;

commit;
