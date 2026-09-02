-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828072319; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Wire fn_audit_fleet_health into the nightly audit. Uses ALTER-by-replace on
-- just the append line: the audit already appends
-- fn_audit_layer_silence_and_coverage; fleet health joins it there so the panel
-- and the 5 AM agent run both see it without any other change.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';

  if v_def is null then
    raise exception 'fn_run_horse_daily_audit not found';
  end if;
  if position('fn_audit_fleet_health' in v_def) > 0 then
    raise notice 'already wired';
    return;
  end if;
  if position('v_findings := v_findings || fn_audit_layer_silence_and_coverage(p_day);' in v_def) = 0 then
    raise exception 'anchor line not found - refusing to guess';
  end if;

  v_new := replace(
    v_def,
    'v_findings := v_findings || fn_audit_layer_silence_and_coverage(p_day);',
    'v_findings := v_findings || fn_audit_layer_silence_and_coverage(p_day);' || chr(10) ||
    '  -- 2026-08-28: fleet health (idle share, over-cap load, bust-sweep lag,' || chr(10) ||
    '  -- seat starvation). Asking these on a schedule replaces a hand-run' || chr(10) ||
    '  -- investigation that got its own arithmetic wrong twice.' || chr(10) ||
    '  v_findings := v_findings || fn_audit_fleet_health(p_day);'
  );

  execute v_new;
end $$;

revoke all on function fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function fn_run_horse_daily_audit(date) to service_role;
