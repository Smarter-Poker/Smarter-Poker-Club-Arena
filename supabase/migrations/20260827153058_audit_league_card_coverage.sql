-- ═══════════════════════════════════════════════════════════════════════════
-- LEAGUE CARD COVERAGE (2026-08-27)
--
-- The nightly league completed 4 of 23 matchups inside its 90-minute budget
-- and stopped cleanly - correct behaviour, invisible consequence: every
-- V15-V18 layer went unmeasured while the four oldest matchups were measured
-- again. Nothing reported it, because "the league ran" was true.
--
-- fn_audit_league_coverage answers the question that matters instead: which
-- matchups have NOT been measured in the last 7 days? The engine now rotates
-- the card daily, so a matchup missing for a week means the rotation is not
-- reaching it and its layer is flying blind.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Matchups seen historically but absent from the last 7 days.
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

  -- A run that produced very few matchups on its own night is worth saying
  -- out loud even before the 7-day window notices.
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

-- Append coverage findings to the daily audit.
create or replace function public.fn_audit_layer_silence_and_coverage(p_day date)
returns jsonb
language sql security definer set search_path = public stable as $$
  select fn_audit_layer_silence(p_day) || fn_audit_league_coverage(p_day);
$$;
revoke all on function public.fn_audit_layer_silence_and_coverage(date) from public;
grant execute on function public.fn_audit_layer_silence_and_coverage(date) to service_role;
