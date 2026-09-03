-- ===========================================================================
-- fn_run_horse_daily_audit: stop a NEW DETECTOR from reporting itself as a
-- brain regression.
--
-- 2026-08-30, found by the daily analysis this function exists to feed.
--
-- The 2026-08-29 audit carried NINE critical `leak_tag_spike` findings:
-- limped_pot_bloat, big_fold_river, big_fold_early, river_raise_war,
-- bet_fold_line, coldcall_stackoff, river_raise_paidoff,
-- straight_into_flush_stackoff and underfull_stackoff, every one of them
-- "spiked" 3-4x against baseline, every one of them recommending the reader
-- diff the day's engine deploys because "the brain regressed on this
-- pattern".
--
-- The brain did not regress. Those ten detectors DID NOT EXIST before
-- 2026-08-28. Measured per 1,000 captured hands:
--
--   tag                     08-26   08-27   08-28   08-29   08-30
--   limped_pot_bloat         0.00    0.00   36.37   67.31   61.97
--   big_fold_river           0.00    0.00   35.47   57.19   57.33
--   river_raise_war          0.00    0.00   19.90   29.61   24.85
--   coldcall_stackoff        0.00    0.00   11.16   21.08   23.65
--
-- Exactly 0.00 for two days, then a partial rollout day, then flat. The
-- detectors that DID exist across the whole window (river_aggr_lost,
-- big_bet_fold, nonnut_flush_stackoff, dominated_straight_stackoff) never
-- moved - which is the control, and it is what says the horses' play was
-- unchanged.
--
-- The arithmetic that produced the false alarm: the baseline counted a tag's
-- occurrences only from the days it existed, but divided by EVERY hand in the
-- 7-day window. A detector shipped yesterday therefore gets a baseline rate
-- diluted by six days of structural zero, and `day_rate > base_rate * 2.5`
-- fires by construction. A detector shipped TODAY hits the
-- `coalesce(b.cnt,0) = 0` branch and is graded critical outright. Either way
-- every new detector spends its first week screaming, and the nine fakes on
-- 08-29 outnumbered and buried the day's real findings.
--
-- THE FIX: a tag is measured only against baseline days on which its detector
-- was actually running. Per tag we take its first appearance in the last 30
-- days, restrict the baseline denominator to days on or after that, and
-- require three such days before a comparison is allowed to mean anything.
-- Below that bar the finding is emitted as INFO that names the detector as
-- new - the same "declining to guess" posture the function already takes for
-- a thin whole-fleet baseline, applied per detector.
--
-- Behaviour deliberately unchanged: thresholds (1.5x warn / 2.5x critical),
-- the 20-occurrence floor, and every other finding in the function.
-- ===========================================================================

create or replace function public.fn_run_horse_daily_audit(p_day date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_stats jsonb;
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_day_hands bigint;
  v_base_hands bigint;
  v_base_days int;
  c_min_baseline_days constant int := 3;
begin
  select jsonb_build_object(
    'flagged_hands', count(*),
    'big_wins', count(*) filter (where is_win),
    'big_losses', count(*) filter (where not is_win),
    'net_bb_sum', round(coalesce(sum(net_bb), 0), 1),
    'by_variant', coalesce((select jsonb_object_agg(game_variant, cnt) from (select game_variant, count(*) cnt from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 group by game_variant) v), '{}'::jsonb),
    'by_format', coalesce((select jsonb_object_agg(format, cnt) from (select format, count(*) cnt from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 group by format) v), '{}'::jsonb),
    'decides', (select coalesce(sum(fires),0) from horse_brain_telemetry where day = p_day and feature = 'decide'),
    'net_bb_all_hands', (select round(coalesce(sum(net_bb),0),1) from horse_daily_nets where day = p_day)
  ) into v_stats from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1;

  select count(*) into v_day_hands
    from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1;

  select count(*), count(distinct played_at::date)
    into v_base_hands, v_base_days
    from horse_hand_reviews where played_at >= p_day - 7 and played_at < p_day;

  if v_base_days >= c_min_baseline_days and v_day_hands > 0 and v_base_hands > 0 then
    for r in
      with day_tags as (
        select tag, count(*) cnt
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day and played_at < p_day + 1
         group by tag
      ),
      -- When each detector first produced anything. Bounded to 30 days: a tag
      -- older than that lands on the window edge, which is already <= the
      -- baseline start, so its baseline stays unrestricted.
      tag_first_seen as (
        select tag, min(played_at)::date as first_day
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day - 30 and played_at < p_day + 1
         group by tag
      ),
      base_day_hands as (
        select played_at::date as d, count(*) as hands
          from horse_hand_reviews
         where played_at >= p_day - 7 and played_at < p_day
         group by 1
      ),
      base_tag_counts as (
        select tag, count(*) cnt
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day - 7 and played_at < p_day
         group by tag
      ),
      -- The denominator a tag is entitled to: only the baseline days on which
      -- its detector was live. At most 7 rows on the right, so this is cheap.
      base_per_tag as (
        select f.tag,
               coalesce(sum(b.hands), 0)::bigint as hands,
               count(b.d)::int                   as days
          from tag_first_seen f
          left join base_day_hands b on b.d >= f.first_day
         group by f.tag
      )
      select d.tag,
             d.cnt,
             (d.cnt::numeric * 1000) / v_day_hands as day_rate,
             case when p.hands > 0
                  then (coalesce(c.cnt, 0)::numeric * 1000) / p.hands
             end                                  as base_rate,
             coalesce(p.days, 0)                   as tag_base_days,
             coalesce(p.hands, 0)                  as tag_base_hands
        from day_tags d
        left join base_per_tag  p using (tag)
        left join base_tag_counts c using (tag)
       where d.cnt >= 20
    loop
      if r.tag_base_days < c_min_baseline_days then
        -- A detector younger than the baseline it would be judged against.
        -- Reported so the rollout is visible, never as a regression.
        v_findings := v_findings || jsonb_build_object(
          'severity','info','category','logic','code','leak_tag_detector_new',
          'title','Leak tag ' || r.tag || ' is too new to baseline',
          'evidence', jsonb_build_object(
            'tag', r.tag,
            'count', r.cnt,
            'rate_per_1k', round(r.day_rate, 2),
            'tag_baseline_days', r.tag_base_days,
            'required_days', c_min_baseline_days,
            'day_hands', v_day_hands),
          'recommendation','This detector has not been running long enough for a spike to mean anything, so no comparison was made. Its first few days establish the baseline; judge it from the day it has ' || c_min_baseline_days || ' full prior days.');
      elsif r.base_rate is not null
            and (r.base_rate = 0 or r.day_rate > r.base_rate * 1.5) then
        v_findings := v_findings || jsonb_build_object(
          'severity', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5 then 'critical' else 'warn' end,
          'category','logic','code','leak_tag_spike',
          'title','Leak tag ' || r.tag || ' spiked',
          'evidence', jsonb_build_object(
            'tag', r.tag,
            'count', r.cnt,
            'rate_per_1k', round(r.day_rate, 2),
            'baseline_rate_per_1k', round(r.base_rate, 2),
            'baseline_days', r.tag_base_days,
            'day_hands', v_day_hands,
            'baseline_hands', r.tag_base_hands),
          'recommendation','Rates are per 1,000 captured hands on both sides and the baseline counts only days this detector was live, so this is neither a volume artifact nor a new-detector artifact. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
      end if;
    end loop;
  else
    v_findings := v_findings || jsonb_build_object(
      'severity','info','category','logic','code','leak_tag_spike_baseline_thin',
      'title','Leak spike detection stood down - ' || v_base_days || ' day(s) of baseline',
      'evidence', jsonb_build_object('baseline_days', v_base_days, 'required_days', c_min_baseline_days,
                                     'day_hands', v_day_hands, 'baseline_hands', v_base_hands),
      'recommendation','Needs ' || c_min_baseline_days || ' distinct prior days of capture before a spike means anything. This is the detector declining to guess, not a finding.');
  end if;

  for r in select horse_user_id, round(sum(net_bb),1) net, count(*) n from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1 group by horse_user_id having sum(net_bb) < -400 order by sum(net_bb) asc limit 10
  loop
    v_findings := v_findings || jsonb_build_object('severity', case when r.net < -800 then 'critical' else 'warn' end,
      'category','gto','code','horse_big_pot_bleed','title','Horse lost ' || abs(r.net) || 'bb across ' || r.n || ' flagged pots',
      'evidence', jsonb_build_object('horse_user_id',r.horse_user_id,'alias',(select coalesce(alias,display_name,username) from profiles where id=r.horse_user_id),'net_bb',r.net,'hands',r.n,
        'tags',(select coalesce(jsonb_object_agg(tag,cnt),'{}'::jsonb) from (select tag,count(*) cnt from horse_hand_reviews, lateral unnest(leak_tags) tag where horse_user_id=r.horse_user_id and played_at>=p_day and played_at<p_day+1 group by tag) t)),
      'recommendation','Review this horse''s flagged hands. Repeated identical tags mean a style/dial problem for the self-tuner; scattered tags with big losses can be variance - check the hand count first.');
  end loop;

  for r in select matchup, bb100, stderr, illegal_actions from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
  loop
    if r.bb100 < 0 and abs(r.bb100) > 2 * r.stderr then
      v_findings := v_findings || jsonb_build_object('severity','critical','category','gto','code','league_layer_negative',
        'title','League matchup ' || r.matchup || ' resolves NEGATIVE','evidence', jsonb_build_object('matchup',r.matchup,'bb100',r.bb100,'stderr',r.stderr),
        'recommendation','A strategy layer is measurably losing money in self-play. Ablate it properly before tuning anything else.');
    end if;
    if r.illegal_actions > 0 then
      v_findings := v_findings || jsonb_build_object('severity','critical','category','logic','code','league_illegal_actions',
        'title','League matchup ' || r.matchup || ' produced illegal actions','evidence', jsonb_build_object('matchup',r.matchup,'illegal_actions',r.illegal_actions),
        'recommendation','The brain emitted a sizing the engine rejects. This reaches live tables as silent check/fold degradation - find the exact branch.');
    end if;
  end loop;

  for r in select h.game_variant, count(*) big_pots from hand_history h
    where h.created_at >= p_day and h.created_at < p_day + 1 and h.pot_size >= 40 * h.big_blind
      and not exists (select 1 from horse_hand_reviews rv where rv.game_variant=h.game_variant and rv.played_at>=p_day and rv.played_at<p_day+1)
    group by h.game_variant having count(*) >= 50
  loop
    v_findings := v_findings || jsonb_build_object('severity','critical','category','schema','code','capture_coverage_gap',
      'title','Variant ' || r.game_variant || ' dealt ' || r.big_pots || ' big pots but wrote zero review rows',
      'evidence', jsonb_build_object('game_variant',r.game_variant,'big_pot_hands',r.big_pots),
      'recommendation','recordHorseHandReviews is not firing for this variant''s settlement path. Read the engine logs for HorseHandReview reportError entries.');
  end loop;

  select count(*) into r from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 and (hole_cards is null or board is null);
  if (r.count) >= 25 then
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','evidence_payload_missing',
      'title',(r.count) || ' review rows missing hole_cards or board','evidence', jsonb_build_object('rows',r.count),
      'recommendation','parseCards rejected the payload shape, or preflop-only pots legitimately have no board. Sample the rows.');
  end if;

  for r in select id, horse_user_id, net_bb, game_variant from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1
      -- 2026-08-28: tournament chips run DEEP in bb terms - a 25k stack at
      -- 25/50 is 500bb, so every early-level tournament stack-off tripped this.
      -- The 2026-08-27 audit carried five such rows, all internally consistent
      -- (net = pot/2 at showdown). Cash keeps the 500bb bar; tournaments flag
      -- only past 1500bb, which no legitimate structure reaches.
      and abs(net_bb) > (case when tournament_id is not null then 1500 else 500 end)
      order by abs(net_bb) desc limit 5
  loop
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','net_outlier',
      'title','Review row with |net| of ' || r.net_bb || 'bb','evidence', jsonb_build_object('review_id',r.id,'horse_user_id',r.horse_user_id,'net_bb',r.net_bb,'variant',r.game_variant),
      'recommendation','Legitimate only for very deep stacks. If the stake caps make this impossible, the contribution/winner inputs disagree.');
  end loop;

  select count(*) into r from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 and not is_win and leak_tags = '{}';
  if (r.count) >= 200 then
    v_findings := v_findings || jsonb_build_object('severity','info','category','logic','code','untagged_losses',
      'title',(r.count) || ' big losses carry no leak tag','evidence', jsonb_build_object('rows',r.count),
      'recommendation','Not every big loss is a mistake - but if manual review keeps finding the same untagged flaw, add a detector.');
  end if;

  v_findings := v_findings || fn_audit_layer_silence_and_coverage(p_day);
  -- 2026-08-28: fleet health (idle share, over-cap load, bust-sweep lag,
  -- seat starvation). Asking these on a schedule replaces a hand-run
  -- investigation that got its own arithmetic wrong twice.
  v_findings := v_findings || fn_audit_fleet_health(p_day);

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats,'{}'::jsonb), v_findings)
  on conflict (day) do update set generated_at = now(), stats = excluded.stats, findings = excluded.findings;
  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end
$function$;

-- ---------------------------------------------------------------------------
-- Nobody in a browser runs the nightly audit.
--
-- Flagged by check-definer-authorization on this very migration: the function
-- is SECURITY DEFINER, it writes horse_daily_audit, and it never asks who is
-- calling - so any authenticated session could have driven a 60-second
-- aggregate over the whole review history, for any date, as often as it
-- liked. It is called by exactly two things: HorseDailyAudit.ts on the engine
-- (service_role) and an agent through the Supabase MCP. Both keep access.
-- PUBLIC is named explicitly: revoking anon and authenticated while PUBLIC
-- still holds EXECUTE reads as a fix and does nothing.
-- ---------------------------------------------------------------------------
revoke all on function public.fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;
