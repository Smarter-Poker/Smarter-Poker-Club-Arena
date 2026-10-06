-- THE AUDIT REPORTS A REFUSED MATCHUP, AND NOTICES IF IT GOES QUIET (2026-09-27)
--
-- Companion to the status/refusal_reason columns. Three changes:
--
--   1. league_matchup_inert now keys on status as well as the 0.00/0.00
--      shape, and carries the reason the runner wrote.
--   2. league_matchup_refused is NEW. A matchup deliberately taken off the
--      card used to leave no trace here at all; it now reports itself every
--      night, with why it cannot be measured and what would change that.
--   3. league_refusal_went_silent closes the loop: once a matchup has been
--      refused, it must keep saying so. If the runner stops writing its
--      refusal row, the matchup is back to being invisible - which is the
--      original defect - so that is a finding in its own right.
--
-- Also corrects the league_card_stale recommendation, which still offered
-- v16_ratio_rescale as a live example of a three-run promotion gate 22 days
-- after it left the card. An audit that argues from a retired experiment is
-- how the v16Ratio decision got stuck.
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
  v_league_ran boolean;
begin
  for r in
    select j.job, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.run_date = p_day
       and j.job in ('league', 'league_pm', 'self_tuner')
     order by j.job
  loop
    -- Execution receipts began on 2026-09-14. Earlier nights keep their
    -- historical liveness check; old audit rows are not retroactive receipts.
    if r.job = 'self_tuner' and p_day >= date '2026-09-14' then
      if not exists(select 1 from public.horse_tuner_study_completions c where c.run_date=p_day) then
        select count(*) into v_rows from public.horse_self_tune_log where run_date=p_day;
        v_findings := v_findings || jsonb_build_object(
          'severity','critical','category','schema','code','nightly_job_incomplete',
          'title','self_tuner claimed ' || p_day || ' without completing its study',
          'evidence',jsonb_build_object('job',r.job,'run_date',p_day,
            'claimed_at',r.claimed_at,'claimed_by',r.claimed_by,
            'individual_audit_rows',v_rows,'completion_receipts',0),
          'recommendation','Resume unfinished horses using their atomic daily receipts. Individual audit rows do not certify the captured eligible cohort.');
      end if;
      continue;
    end if;
    if r.job in ('league', 'league_pm') then
      -- A refusal row is not evidence the card ran: it is written before the
      -- first hand is dealt and would mask a night that produced nothing.
      select count(*) into v_rows
        from horse_league_results
       where run_date = p_day and status <> 'refused';
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

  select max(run_date) into v_last_league from horse_league_results where status <> 'refused';
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
      select count(*) into v_matchups
        from horse_league_results where run_date = v_last_league and status <> 'refused';
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
          'run cannot satisfy any three-run promotion gate. Fix the runner ' ||
          'before tuning anything on this card. (v16_ratio_rescale is no ' ||
          'longer an example of such a gate: it left the card on 2026-09-05 ' ||
          'and now reports as status = refused. Read that row - it carries ' ||
          'the reason and what would change the verdict.)'
      );
    end if;
  end if;

  -- An INERT matchup dealt real hands and learned nothing: a harness fault.
  for r in
    select matchup, hands, refusal_reason
      from horse_league_results
     where run_date = p_day
       and hands > 0
       and (status = 'inert' or (bb100 = 0 and stderr = 0))
     order by matchup
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'league_matchup_inert',
      'title', r.matchup || ' returned exactly zero over ' || r.hands || ' hands',
      'evidence', jsonb_build_object('matchup', r.matchup, 'hands', r.hands,
                                     'reason', r.refusal_reason),
      'recommendation',
        'Both arms played identically. Confirm the b-side flag still gates ' ||
        'live code; if it does not, the layer is unreachable or the flag is ' ||
        'dead and the matchup should be retired or repointed. Retire it into ' ||
        'UNMEASURABLE_MATCHUPS so it keeps reporting - never by deleting the ' ||
        'entry, which makes it invisible to this finding.'
    );
  end loop;

  -- A REFUSED matchup dealt nothing on purpose. This is the state that used
  -- to be unrepresentable, and therefore unarguable.
  for r in
    select matchup, refusal_reason
      from horse_league_results
     where run_date = p_day and status = 'refused'
     order by matchup
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'gto',
      'code', 'league_matchup_refused',
      'title', r.matchup || ' is deliberately not measured',
      'evidence', jsonb_build_object('matchup', r.matchup, 'reason', r.refusal_reason),
      'recommendation',
        'Not a gap in the card - a recorded judgement that self-play cannot ' ||
        'answer this question at a sample the league can afford. The reason ' ||
        'states what would change that. Decide FROM this row; the absence of ' ||
        'a measurement is not evidence either way, and a flag that no longer ' ||
        'reaches code cannot satisfy a promotion gate however long it waits.'
    );
  end loop;

  -- Once refused, it must keep saying so. Silence here is the original bug.
  select exists(select 1 from horse_league_results where run_date = p_day)
    into v_league_ran;
  if v_league_ran then
    for r in
      select distinct h.matchup
        from horse_league_results h
       where h.status = 'refused'
         and h.run_date >= p_day - 7
         and h.run_date < p_day
         and not exists (select 1 from horse_league_results t
                          where t.matchup = h.matchup and t.run_date = p_day)
       order by 1
    loop
      v_findings := v_findings || jsonb_build_object(
        'severity', 'warn',
        'category', 'schema',
        'code', 'league_refusal_went_silent',
        'title', r.matchup || ' was refused within the last week and said nothing on ' || p_day,
        'evidence', jsonb_build_object('matchup', r.matchup, 'run_date', p_day),
        'recommendation',
          'The league ran but wrote no refusal row for this matchup, so it is ' ||
          'invisible again - the exact failure the refusal rows exist to ' ||
          'prevent. Either it went back on the card (then it should have a ' ||
          'measurement) or writeRefusedMatchups stopped running.'
      );
    end loop;
  end if;

  return v_findings;
end
$function$;