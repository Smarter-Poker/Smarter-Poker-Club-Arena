-- ============================================================================
-- THE DAILY AUDIT'S BASELINE COMES FROM THE ROLLUP (2026-09-05)
-- ============================================================================
--
-- Follow-on to daily_audit_fits_its_timeout_and_reads_its_own_steps, applied
-- an hour earlier in the same session. With the 89.9s hand_history scan gone,
-- fn_run_horse_daily_audit ran in 3.45s warm - and 41.8s on its first, cold
-- call. What was left: the seven-day baseline and the thirty-day first-seen
-- scan both read horse_hand_reviews with a lateral unnest over leak_tags,
-- which means every heap page (actions jsonb included) for up to a month of
-- rows. That is precisely what is cold at 06:00 UTC when the engine runs.
--
-- horse_review_rollup carries the same counts per horse/day/variant, written
-- by fn_hhr_rollup_add on every review insert: a few thousand small rows per
-- week. Verified on the live data before switching: first-seen day identical
-- for all 22 tags; seven-day hand counts and per-tag counts within 0.1% (the
-- rollup add is fire-and-forget and loses a handful of rows a day) - a
-- difference in the third decimal of a per-1k rate. The DAY side of every
-- comparison stays on horse_hand_reviews, exact and hot.
--
-- One CREATE OR REPLACE, one transaction, one schema reload.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_run_horse_daily_audit(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_stats jsonb;
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_day_hands bigint;
  v_base_hands bigint;
  v_base_days int;
  v_big_pots bigint;
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

  -- ── THE BASELINE COMES FROM THE ROLLUP (2026-09-05) ──
  -- The seven-day baseline and the thirty-day first-seen scan used to read
  -- horse_hand_reviews with a lateral unnest over leak_tags - every row's
  -- heap page, actions jsonb and all, for up to a month of rows. Warm that is
  -- a second; cold it was most of a 41.8s run measured on 2026-09-05 after
  -- the hand_history scan was already gone, against an 8s ceiling. The
  -- engine's 06:00 window is exactly when those pages are cold.
  -- horse_review_rollup is the same counts per horse/day/variant, written by
  -- fn_hhr_rollup_add on every review insert, a few thousand small rows for a
  -- week. Verified on the live data: first-seen days identical for all 22
  -- tags; seven-day hand counts and tag counts within 0.1% (the rollup add is
  -- fire-and-forget and loses a handful of rows), which moves a per-1k rate
  -- in the third decimal and no verdict. The DAY side stays on
  -- horse_hand_reviews, exact and hot.
  select coalesce(sum(big_wins + big_losses), 0), count(distinct day)
    into v_base_hands, v_base_days
    from horse_review_rollup where day >= p_day - 7 and day < p_day;

  if v_base_days >= c_min_baseline_days and v_day_hands > 0 and v_base_hands > 0 then
    for r in
      with day_tags as (
        select tag, count(*) cnt
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day and played_at < p_day + 1
         group by tag
      ),
      tag_first_seen as (
        select k as tag, min(day) as first_day
          from horse_review_rollup, lateral jsonb_object_keys(leak_counts) k
         where day >= p_day - 30 and day <= p_day
         group by k
      ),
      base_day_hands as (
        select day as d, sum(big_wins + big_losses)::bigint as hands
          from horse_review_rollup
         where day >= p_day - 7 and day < p_day
         group by 1
      ),
      base_tag_counts as (
        select k as tag, sum((leak_counts->>k)::bigint) as cnt
          from horse_review_rollup, lateral jsonb_object_keys(leak_counts) k
         where day >= p_day - 7 and day < p_day
         group by k
      ),
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

  -- ── capture_coverage_gap (rewritten 2026-09-05) ──────────────────────────
  -- This step used to scan the WHOLE DAY of hand_history (681,878 rows on
  -- 2026-09-04: 700,896 buffers through idx_hand_history_created with a heap
  -- filter on pot_size, 89.9 seconds measured) to answer a question whose
  -- normal answer is "nothing to report". It was the entire reason the
  -- engine's nightly daily_audit could not finish: service_role runs at an
  -- 8s statement_timeout and the engine client aborts at 15s, and the SET
  -- statement_timeout '60s' on this function cannot re-arm a timer that was
  -- armed at statement start. Every other step here runs in under a second.
  --
  -- The question is "did a variant deal big pots today and write NO review
  -- rows". Both halves are cheap without hand_history: the variants dealt
  -- come from horse_daily_nets (written per horse-hand at settlement, one
  -- small row per horse/variant/day), the variants reviewed come from
  -- idx_hhr_played. Only for a variant that has nets rows and no reviews -
  -- the abnormal case the finding exists for - is hand_history probed, and
  -- then with LIMIT 50: fifty big pots are enough to raise the finding and
  -- the scan stops the moment it has them.
  for r in
    select n.game_variant
      from (select distinct game_variant from horse_daily_nets where day = p_day and hands > 0) n
     where not exists (select 1 from horse_hand_reviews rv
                        where rv.game_variant = n.game_variant
                          and rv.played_at >= p_day and rv.played_at < p_day + 1)
  loop
    select count(*) into v_big_pots from (
      select 1 from hand_history h
       where h.created_at >= p_day and h.created_at < p_day + 1
         and h.game_variant = r.game_variant
         and h.pot_size >= 40 * h.big_blind
       limit 50) probe;
    if v_big_pots >= 50 then
      v_findings := v_findings || jsonb_build_object('severity','critical','category','schema','code','capture_coverage_gap',
        'title','Variant ' || r.game_variant || ' dealt at least ' || v_big_pots || ' big pots but wrote zero review rows',
        'evidence', jsonb_build_object('game_variant',r.game_variant,'big_pot_hands',v_big_pots,'probe_limit',50),
        'recommendation','recordHorseHandReviews is not firing for this variant''s settlement path. Read the engine logs for HorseHandReview reportError entries.');
    end if;
  end loop;

  select count(*) into r from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 and (hole_cards is null or board is null);
  if (r.count) >= 25 then
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','evidence_payload_missing',
      'title',(r.count) || ' review rows missing hole_cards or board','evidence', jsonb_build_object('rows',r.count),
      'recommendation','parseCards rejected the payload shape, or preflop-only pots legitimately have no board. Sample the rows.');
  end if;

  for r in select id, horse_user_id, net_bb, game_variant from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1
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
  v_findings := v_findings || fn_audit_fleet_health(p_day);
  -- 2026-09-01: a claimed-but-empty nightly job, a stale league card,
  -- and a matchup whose two arms are identical. See
  -- 20260901_audit_a_lost_nightly_job_is_loud.sql.
  v_findings := v_findings || fn_audit_nightly_job_health(p_day);
  -- 2026-09-01: river aggression judged on EV across BOTH outcomes.
  v_findings := v_findings || fn_audit_river_aggression_ev(p_day);
  -- 2026-09-01: layers that stopped firing or collapsed, derived from
  -- what each layer has actually done - no hand-maintained watchlist.
  v_findings := v_findings || fn_audit_layer_drift(p_day);
  -- 2026-09-01: a conservation breach stays reported until a person
  -- explains it. The deploy gate forgets after four hours; this does not.
  v_findings := v_findings || fn_audit_supply_breaches(p_day);
  -- Phase 1 of the real-time build plan (2026-09-04): every ledger receipt
  -- judged against its expected share, every nightly source for freshness.
  v_findings := v_findings || fn_audit_data_receipts(p_day);

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats,'{}'::jsonb), v_findings)
  on conflict (day) do update set generated_at = now(), stats = excluded.stats, findings = excluded.findings;

  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end
$function$;

COMMIT;

-- Same closure as the migration an hour before it: engine and panel only.
REVOKE ALL ON FUNCTION public.fn_run_horse_daily_audit(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_horse_daily_audit(date) TO service_role;
