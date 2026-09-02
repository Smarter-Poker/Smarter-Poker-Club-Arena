-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827163617; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- LEAGUE POOLING + ANALYSIS WATCHDOG (2026-08-27)
-- Repo: supabase/migrations/20260827163548_league_pooling_and_analysis_watchdog.sql

create or replace function public.fn_league_pooled(p_day date, p_days int default 7)
returns table (
  matchup text,
  runs int,
  hands bigint,
  bb100 numeric,
  stderr numeric,
  verdict text,
  newest_run date
)
language sql security definer set search_path = public stable as $$
  with rows as (
    select r.matchup, r.bb100::numeric b, greatest(r.stderr::numeric, 0.01) s,
           r.hands::bigint h, r.run_date
    from horse_league_results r
    where r.run_date > p_day - greatest(p_days, 1)
      and r.run_date <= p_day + 1
  ), pooled as (
    select rows.matchup,
           count(*)::int runs,
           sum(rows.h) hands,
           sum(rows.b / (rows.s * rows.s)) / nullif(sum(1.0 / (rows.s * rows.s)), 0) bb100,
           sqrt(1.0 / nullif(sum(1.0 / (rows.s * rows.s)), 0)) stderr,
           max(rows.run_date) newest_run
    from rows group by rows.matchup
  )
  select p.matchup, p.runs, p.hands,
         round(p.bb100, 2), round(p.stderr, 2),
         case when abs(p.bb100) > 2 * p.stderr then 'SIGNIFICANT' else 'not resolved' end,
         p.newest_run
  from pooled p
  order by p.bb100 desc;
$$;
revoke all on function public.fn_league_pooled(date, int) from public;
grant execute on function public.fn_league_pooled(date, int) to authenticated, service_role;

create or replace function public.fn_audit_league_pooled_findings(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v jsonb := '[]'::jsonb; r record;
begin
  for r in select * from fn_league_pooled(p_day, 7) loop
    if r.verdict = 'SIGNIFICANT' and r.bb100 < 0 then
      v := v || jsonb_build_object(
        'severity', 'critical', 'category', 'gto', 'code', 'league_layer_negative_pooled',
        'title', 'Pooled over ' || r.runs || ' run(s): ' || r.matchup || ' resolves NEGATIVE at ' || r.bb100 || ' bb/100',
        'evidence', jsonb_build_object('matchup', r.matchup, 'bb100', r.bb100, 'stderr', r.stderr,
                                       'runs', r.runs, 'hands', r.hands, 'newest_run', r.newest_run),
        'recommendation', 'This layer is measurably losing money across every night it was measured. Ablate it properly before tuning anything else - and check whether a recent change to it caused the flip.'
      );
    end if;
    if r.verdict = 'SIGNIFICANT' and r.bb100 > 0 and r.matchup = 'v16_ratio_rescale' then
      v := v || jsonb_build_object(
        'severity', 'info', 'category', 'gto', 'code', 'flagged_experiment_earned_its_keep',
        'title', 'v16_ratio_rescale is pooled-SIGNIFICANT positive (' || r.bb100 || ' bb/100 over ' || r.runs || ' runs)',
        'evidence', jsonb_build_object('bb100', r.bb100, 'stderr', r.stderr, 'runs', r.runs),
        'recommendation', 'The default-OFF experiment has earned its default. Ship a PR flipping v16Ratio to default ON, citing these runs.'
      );
    end if;
  end loop;
  return v;
end $$;
revoke all on function public.fn_audit_league_pooled_findings(date) from public;
grant execute on function public.fn_audit_league_pooled_findings(date) to service_role;

create or replace function public.fn_audit_analysis_watchdog(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v jsonb := '[]'::jsonb; a record; claimed boolean;
begin
  select day, agent_analyzed_at into a from horse_daily_audit where day = p_day;
  if not found then return v; end if;
  select exists(select 1 from horse_job_runs where job = 'claude_daily_analysis' and run_date = p_day)
    into claimed;

  if now() < (p_day + 2)::timestamptz then return v; end if;

  if a.agent_analyzed_at is null then
    v := v || jsonb_build_object(
      'severity', 'critical', 'category', 'schema',
      'code', case when claimed then 'analysis_claimed_but_never_written' else 'analysis_never_ran' end,
      'title', case when claimed
                 then 'The daily analysis CLAIMED ' || p_day || ' and never wrote a verdict'
                 else 'No daily analysis ran for ' || p_day end,
      'evidence', jsonb_build_object('day', p_day, 'claimed', claimed, 'agent_analyzed_at', null),
      'recommendation', case when claimed
        then 'A runner took the claim and died mid-run. Check that account''s Claude app was open and the run completed; the claim row is what lets a backup runner take over after 14:00 UTC.'
        else 'No Claude account executed the schedule for this day - the app was closed on every machine carrying it, or the task is disabled. The machine findings above still stand on their own.' end
    );
  end if;
  return v;
end $$;
revoke all on function public.fn_audit_analysis_watchdog(date) from public;
grant execute on function public.fn_audit_analysis_watchdog(date) to service_role;

create or replace function public.fn_audit_layer_silence_and_coverage(p_day date)
returns jsonb
language sql security definer set search_path = public stable as $$
  select fn_audit_layer_silence(p_day)
       || fn_audit_league_coverage(p_day)
       || fn_audit_league_pooled_findings(p_day)
       || fn_audit_analysis_watchdog(p_day);
$$;
revoke all on function public.fn_audit_layer_silence_and_coverage(date) from public;
grant execute on function public.fn_audit_layer_silence_and_coverage(date) to service_role;
