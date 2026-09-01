-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901124714; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_audit_nightly_job_health(p_day date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_rows bigint;
  v_last_league date;
  v_gap int;
  v_matchups bigint;
begin
  for r in
    select j.job, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.run_date = p_day
       and j.job in ('league', 'league_pm', 'self_tuner')
     order by j.job
  loop
    if r.job in ('league', 'league_pm') then
      select count(*) into v_rows from horse_league_results where run_date = p_day;
    else
      select count(*) into v_rows from horse_self_tune_log where run_date = p_day;
    end if;

    if v_rows = 0 then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'critical',
        'category', 'schema',
        'code', 'nightly_job_lost',
        'title', r.job || ' claimed ' || p_day || ' and produced nothing',
        'evidence', jsonb_build_object(
          'job', r.job,
          'run_date', p_day,
          'claimed_at', r.claimed_at,
          'claimed_by', r.claimed_by,
          'evidence_rows', 0
        ),
        'recommendation',
          'The job took the lock and died before writing a row - an engine ' ||
          'restart inside the run is the usual cause, and server/** merges ' ||
          'deploy automatically. Check the container logs for that window. ' ||
          'Any conclusion drawn from this job for this date is unsupported: ' ||
          'do not quote it.'
      );
    end if;
  end loop;

  select max(run_date) into v_last_league from horse_league_results;
  if v_last_league is null then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'critical',
      'category', 'schema',
      'code', 'league_card_empty',
      'title', 'horse_league_results has no rows at all',
      'evidence', jsonb_build_object('as_of', p_day),
      'recommendation',
        'No layer has ever been measured. Every strategy verdict is opinion ' ||
        'until the league runs.'
    );
  else
    v_gap := p_day - v_last_league;
    if v_gap >= 1 then
      select count(*) into v_matchups from horse_league_results where run_date = v_last_league;
      v_findings := v_findings || jsonb_build_object(
        'severity', case when v_gap >= 2 then 'critical' else 'warn' end,
        'category', 'schema',
        'code', 'league_card_stale',
        'title', 'The newest league measurement is ' || v_gap || ' day(s) before ' || p_day,
        'evidence', jsonb_build_object(
          'last_run_date', v_last_league,
          'days_stale', v_gap,
          'matchups_in_last_run', v_matchups
        ),
        'recommendation',
          'Layer verdicts are being read off a card this many days old. ' ||
          'Significance rules assume independent runs, so a single surviving ' ||
          'run cannot satisfy any three-run gate (v16_ratio_rescale in ' ||
          'particular). Fix the runner before tuning anything on this card.'
      );
    end if;
  end if;

  for r in
    select matchup, hands
      from horse_league_results
     where run_date = p_day and bb100 = 0 and stderr = 0 and hands > 0
     order by matchup
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'league_matchup_inert',
      'title', r.matchup || ' returned exactly zero over ' || r.hands || ' hands',
      'evidence', jsonb_build_object('matchup', r.matchup, 'hands', r.hands),
      'recommendation',
        'Both arms played identically. Confirm the b-side flag still gates ' ||
        'live code; if it does not, the layer is unreachable or the flag is ' ||
        'dead and the matchup should be retired or repointed.'
    );
  end loop;

  return v_findings;
end
$function$;

revoke all on function public.fn_audit_nightly_job_health(date) from public, anon, authenticated;
grant execute on function public.fn_audit_nightly_job_health(date) to service_role;

do $splice$
declare
  v_def text;
  v_anchor constant text := 'v_findings := v_findings || fn_audit_fleet_health(p_day);';
  v_new constant text := 'v_findings := v_findings || fn_audit_fleet_health(p_day);'
    || E'\n  -- 2026-09-01: a claimed-but-empty nightly job, a stale league card,'
    || E'\n  -- and a matchup whose two arms are identical. See'
    || E'\n  -- 20260901_audit_a_lost_nightly_job_is_loud.sql.'
    || E'\n  v_findings := v_findings || fn_audit_nightly_job_health(p_day);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';

  if v_def is null then
    raise exception 'fn_run_horse_daily_audit does not exist - nothing to splice into';
  end if;

  if position('fn_audit_nightly_job_health(p_day)' in v_def) > 0 then
    raise notice 'nightly-job health hook already present - nothing to do';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception
      'expected exactly one fleet-health hook to anchor on, found %',
      (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  end if;

  execute replace(v_def, v_anchor, v_new);
end
$splice$;

revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;

do $assert$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_run_horse_daily_audit';

  if position('fn_audit_nightly_job_health(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the audit does not call the new health check';
  end if;
  if position('fn_audit_fleet_health(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the fleet-health hook was lost by the splice';
  end if;
  if position('fn_audit_layer_silence_and_coverage(p_day)' in v_def) = 0 then
    raise exception 'POST-APPLY: the layer-silence hook was lost by the splice';
  end if;
  if to_regprocedure('public.fn_audit_nightly_job_health(date)') is null then
    raise exception 'POST-APPLY: fn_audit_nightly_job_health was not created';
  end if;
end
$assert$;
