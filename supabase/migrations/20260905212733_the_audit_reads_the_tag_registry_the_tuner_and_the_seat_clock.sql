-- ═══════════════════════════════════════════════════════════════════════════
-- THE AUDIT READS THE TAG REGISTRY, THE TUNER, AND THE SEAT CLOCK
-- (2026-09-05, the hardening layer of the horse deep audit)
--
-- Every fix in the audit was a thing that had silently stopped mattering:
-- tags nobody read, a tuner rule reading rake as a leak, a fleet-state
-- column nobody wrote. Each of those now has a detector that fires the day
-- it happens again:
--
--   fn_audit_tag_consumers   a tag with 100+ rows this week whose ledger row
--                            (kind 'tag', synced from HorseDataLedger.
--                            TAG_CONSUMERS at boot) says 'measurement', or
--                            has no ledger row at all -> tag_unread.
--   fn_audit_tuner_health    the night's self-tune log: more than 40% of
--                            tuned horses regressed -> the rake rule is back;
--                            fewer than 60% of horses came from play rows
--                            once horse_daily_play is a week old -> the
--                            settlement compiler is off; zero rows -> loud.
--   fn_audit_seat_clock      seated horses whose last_action_at never moves
--                            while the fleet decided all day -> the touch
--                            stopped.
--   horse_big_pot_bleed      fleet-relative: a horse is a bleed only under
--                            the fleet's day p10 AND under -400bb (the 09-04
--                            analysis: "the daily tail of a rake-shaped
--                            distribution reads as ten criticals every day").
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_tag_consumers(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_registry int;
begin
  select count(*) into v_registry from horse_data_ledger where kind = 'tag';
  if v_registry = 0 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','tag_registry_missing',
      'title','horse_data_ledger has no tag rows - the engine has not synced TAG_CONSUMERS',
      'evidence', jsonb_build_object('rows', 0),
      'recommendation','HorseDataLedgerSync writes the tag registry at boot. Until the engine restarts on a build that carries TAG_CONSUMERS, tag_unread cannot be judged.');
    return v;
  end if;
  for r in
    with week as (
      select k as tag, sum((leak_counts->>k)::bigint) as n
        from horse_review_rollup, lateral jsonb_object_keys(leak_counts) k
       where day > p_day - 7 and day <= p_day
       group by k
    )
    select w.tag, w.n,
           l.consumer,
           case when w.tag like '%\_won' escape '\' then substr(w.tag, 1, length(w.tag) - 4) end as base
      from week w
      left join horse_data_ledger l on l.kind = 'tag' and l.key = 'tag:' || w.tag
     where w.n >= 100
     order by w.n desc
  loop
    if r.consumer is null and r.base is not null then
      -- a _won twin is registered under its loss tag
      continue;
    end if;
    if r.consumer is null then
      v := v || jsonb_build_object('severity','warn','category','logic','code','tag_unread',
        'title','Leak tag ' || r.tag || ' (' || r.n || ' rows this week) has no ledger row',
        'evidence', jsonb_build_object('tag', r.tag, 'rows_7d', r.n),
        'recommendation','A detector emits this tag and HorseDataLedger.TAG_CONSUMERS does not know it. EveryTagHasAConsumer.law.test.ts should have failed; if the engine is older than the tag, redeploy. Register it with the code that reads it, or as measurement with the reason.');
    elsif r.consumer = 'measurement' and r.n >= 1000 then
      v := v || jsonb_build_object('severity','info','category','logic','code','tag_measurement_only',
        'title','Leak tag ' || r.tag || ' (' || r.n || ' rows this week) is measurement only',
        'evidence', jsonb_build_object('tag', r.tag, 'rows_7d', r.n, 'reason', (select note from horse_data_ledger where kind = 'tag' and key = 'tag:' || r.tag)),
        'recommendation','Registered as read by nobody, with a reason. Volume this high is worth a decision: wire a consumer with a receipt, or keep the reason current.');
    end if;
  end loop;
  return v;
end $$;

revoke all on function public.fn_audit_tag_consumers(date) from public, authenticated, anon;
grant execute on function public.fn_audit_tag_consumers(date) to service_role;

create or replace function public.fn_audit_tuner_health(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  v_rows int;
  v_regress int;
  v_play int;
  v_play_age int;
  v_run date := p_day + 1;  -- the tuner runs at 08:00 UTC the morning after
begin
  select count(*),
         count(*) filter (where array_to_string(reasons, ' ') like '%regress dials halfway%'),
         count(*) filter (where (stats->>'study_source')::int = 1)
    into v_rows, v_regress, v_play
    from horse_self_tune_log where run_date = v_run;
  if v_rows = 0 then
    -- fn_audit_nightly_job_health already reports a claimed-but-empty night;
    -- this is the horse-facing consequence.
    v := v || jsonb_build_object('severity','warn','category','logic','code','tuner_no_rows',
      'title','No self-tune rows for ' || v_run || ' - the leak profiles did not move',
      'evidence', jsonb_build_object('run_date', v_run),
      'recommendation','HorseSelfTuner is the only writer of profiles.horse_profile.leaks*; every night it does not run, the brain reads stale verdicts. See the nightly_job_health finding for the claim.');
    return v;
  end if;
  if v_regress::numeric / v_rows > 0.4 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_regressed_the_fleet',
      'title', v_regress || ' of ' || v_rows || ' tuned horses regressed to neutral on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'regressed', v_regress, 'share', round(v_regress::numeric / v_rows, 3)),
      'recommendation','The regression rule is reading the rake as a leak again (2026-09-04: 221 of 383). It must judge net_bb + rake_bb and only a horse under the fleet p25 - see RegressionContext in HorseSelfTuner.ts and TheTunerDoesNotFightTheRake.law.test.ts. Check rake_bb is accumulating in horse_daily_nets.');
  end if;
  select count(distinct day) into v_play_age from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_age >= 6 and v_play::numeric / v_rows < 0.6 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','tuner_studied_from_stream',
      'title', (v_rows - v_play) || ' of ' || v_rows || ' tuned horses came from the hand_history stream, not horse_daily_play',
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'from_play_rows', v_play, 'play_days_in_window', v_play_age),
      'recommendation','horse_daily_play has a week of rows, so the tuner should study nearly every horse from it. Either the settlement compiler (HorseHandReview.accumulateHorsePlay) is off (HORSE_PLAY_ROLLUP_ENABLED) or loadPlayRows is failing (horse_error_log context HorseSelfTuner.playRows).');
  end if;
  return v;
end $$;

revoke all on function public.fn_audit_tuner_health(date) from public, authenticated, anon;
grant execute on function public.fn_audit_tuner_health(date) to service_role;

create or replace function public.fn_audit_seat_clock(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  v_seated int;
  v_touched int;
  v_decides bigint;
begin
  select count(*) filter (where state = 'seated'),
         count(*) filter (where state = 'seated' and last_action_at >= now() - interval '2 hours')
    into v_seated, v_touched
    from ca_horse_fleet_state;
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';
  if v_seated >= 50 and v_decides >= 100000 and v_touched = 0 then
    v := v || jsonb_build_object('severity','critical','category','schema','code','seat_clock_dead',
      'title', v_seated || ' seated horses and none has a last_action_at in the last two hours, against ' || v_decides || ' decisions on ' || p_day,
      'evidence', jsonb_build_object('seated', v_seated, 'touched_2h', v_touched, 'decides', v_decides),
      'recommendation','fn_ca_fleet_seat_touch is not being called (HorseHandReview.touchHorseSeats, HORSE_SEAT_TOUCH_ENABLED) or the fleet upsert is overwriting it again (fn_ca_fleet_state_upsert must coalesce last_action_at). The panel cannot tell a playing horse from a stuck one without it.');
  end if;
  return v;
end $$;

revoke all on function public.fn_audit_seat_clock(date) from public, authenticated, anon;
grant execute on function public.fn_audit_seat_clock(date) to service_role;

-- Wire the three into the nightly audit and make the bleed detector
-- fleet-relative, both patched in place from the live definition.
do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into d;
  if position('fn_audit_tag_consumers(p_day)' in d) = 0 then
    d := replace(d,
      'v_findings := v_findings || fn_audit_data_receipts(p_day);',
      'v_findings := v_findings || fn_audit_data_receipts(p_day);' || chr(10) ||
      '  -- 2026-09-05 hardening: the tag registry, the tuner, the seat clock.' || chr(10) ||
      '  v_findings := v_findings || fn_audit_tag_consumers(p_day);' || chr(10) ||
      '  v_findings := v_findings || fn_audit_tuner_health(p_day);' || chr(10) ||
      '  v_findings := v_findings || fn_audit_seat_clock(p_day);');
  end if;
  if position('fleet_p10' in d) = 0 then
    d := replace(d,
      'group by horse_user_id having sum(net_bb) < -400 order by sum(net_bb) asc limit 10',
      'group by horse_user_id having sum(net_bb) < least(-400, (select percentile_cont(0.1) within group (order by fleet_p10.s) from (select sum(net_bb) as s from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 group by horse_user_id) fleet_p10)) order by sum(net_bb) asc limit 10');
  end if;
  execute d;
end $patch$;
