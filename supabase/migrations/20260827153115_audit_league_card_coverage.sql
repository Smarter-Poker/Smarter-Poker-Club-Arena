-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827153115; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- LEAGUE CARD COVERAGE (2026-08-27). Repo: supabase/migrations/20260827153058_audit_league_card_coverage.sql

create or replace function public.fn_audit_league_coverage(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_findings jsonb := '[]'::jsonb;
  v_recent int;
  v_stale text[];
begin
  select count(distinct matchup) into v_recent
  from horse_league_results where run_date > p_day - 7;

  select coalesce(array_agg(m order by m), '{}')
    into v_stale
  from (
    select distinct matchup m from horse_league_results where run_date > p_day - 45
    except
    select distinct matchup from horse_league_results where run_date > p_day - 7
  ) s;

  if array_length(v_stale, 1) > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'gto',
      'code', 'league_card_starved',
      'title', array_length(v_stale, 1) || ' league matchup(s) unmeasured for 7+ days',
      'evidence', jsonb_build_object('stale_matchups', to_jsonb(v_stale), 'measured_last_7d', v_recent),
      'recommendation', 'The nightly budget is not reaching these matchups even with daily rotation. Their layers are unmeasured - reduce PAIRS_PER_MATCHUP, raise MAX_RUN_MS, or trim the card. A layer nobody measures is a layer nobody can defend.'
    );
  end if;

  if exists (
    select 1 from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
    group by run_date having count(*) < 6
  ) then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'gto',
      'code', 'league_run_partial',
      'title', 'The latest league run completed fewer than 6 matchups',
      'evidence', jsonb_build_object(
        'run_date', (select max(run_date) from horse_league_results where run_date <= p_day + 1),
        'matchups', (select count(*) from horse_league_results
                     where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1))
      ),
      'recommendation', 'Expected with a large card and a fixed budget - the rotation covers the rest over following nights. Only a concern if the same matchups keep leading every night.'
    );
  end if;

  return v_findings;
end $$;

revoke all on function public.fn_audit_league_coverage(date) from public;
grant execute on function public.fn_audit_league_coverage(date) to service_role;

create or replace function public.fn_audit_layer_silence_and_coverage(p_day date)
returns jsonb
language sql security definer set search_path = public stable as $$
  select fn_audit_layer_silence(p_day) || fn_audit_league_coverage(p_day);
$$;
revoke all on function public.fn_audit_layer_silence_and_coverage(date) from public;
grant execute on function public.fn_audit_layer_silence_and_coverage(date) to service_role;
