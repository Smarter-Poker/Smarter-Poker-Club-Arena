-- Wire fn_audit_fleet_health into the nightly audit, by a TARGETED replace of
-- the single line that appends fn_audit_layer_silence_and_coverage. Replacing
-- the whole audit body here would fork it from whatever the newest migration
-- shipped; this edits one line of the LIVE definition and refuses if the
-- anchor is missing rather than guessing. Applied via MCP 2026-08-28.
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
    '  v_findings := v_findings || fn_audit_fleet_health(p_day);'
  );

  execute v_new;
end $$;

revoke all on function fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function fn_run_horse_daily_audit(date) to service_role;
