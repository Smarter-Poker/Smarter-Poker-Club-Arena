-- 20261031200256_leak_spike_judges_the_loss_side_only.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_run_horse_daily_audit's leak-spike loop iterated EVERY tag of the day,
-- including the `_won` win mirrors HorseHandReview.flag() records for the
-- same situation. Its own comment says "The count above is the LOSS side
-- only", but nothing excluded the mirrors. On 2026-10-30 that raised
-- plo_set_stackoff_won (268 tags, rate 4.33 vs 1.32 per 1k) as a CRITICAL
-- leak_tag_spike: the tag maps back to its situation, the situation's
-- seven-day mirrored EV is negative (-39.62 bb/hand over 3,237 hands), so the
-- WIN side was reported as the leak. The daily analysis sampled the
-- lowest-net hands for that tag and every one was a win. The loss side
-- (plo_set_stackoff) is still judged under its own name, and
-- fn_horse_tag_ev / fn_audit_river_aggression_ev still rank both outcomes.
--
-- The only change is one predicate in the spike loop. The body is the live
-- body installed by 20261025145108 (md5 of prosrc f7bcaef328aa885d8f9a4dd99603c6be,
-- 23,086 characters, read 2026-10-31); the DO block refuses to replace any
-- other body.
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_run_horse_daily_audit(date)'::regprocedure)
     IS DISTINCT FROM 'f7bcaef328aa885d8f9a4dd99603c6be' THEN
    RAISE EXCEPTION 'fn_run_horse_daily_audit is not the 20261025145108 body this migration was written against';
  END IF;
END
$guard$;

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
         -- THE SPIKE IS JUDGED ON THE LOSS SIDE ONLY (2026-10-31). A
         -- `<situation>_won` tag is the WIN mirror HorseHandReview.flag()
         -- records for the same line; its loss side is judged here under its
         -- own name and fn_horse_tag_ev already pairs both. On 2026-10-30
         -- plo_set_stackoff_won (268, every sampled hand a win) was raised as
         -- a CRITICAL leak spike beside plo_set_stackoff, the real finding.
         and d.tag not like '%\_won'
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
        declare
          /*
           * A RISE IS NOT A LEAK UNTIL THE MIRRORED EV SAYS SO (2026-09-14).
           * The count above is the LOSS side only. fn_horse_tag_ev pairs it
           * with its _won mirror over seven days, which is the ranking
           * fn_audit_river_aggression_ev already treats as the honest one. A
           * situation that is winning money did not regress because it
           * happened more often. Null means under 100 hands in the window, or
           * the fold family, which has no winning mirror by construction -
           * then the original warn stands, because nothing contradicted it.
           */
          v_situation text := case
            when r.tag like '%\_won'  then left(r.tag, length(r.tag) - 4)
            when r.tag like '%\_lost' then left(r.tag, length(r.tag) - 5)
            else r.tag
          end;
          v_ev_bb    numeric;
          v_ev_hands bigint;
          v_ev_win   numeric;
          v_ev_z     numeric;
          v_ev_sd    numeric;
        begin
          select e.bb_per_hand, e.hands, e.win_rate
            into v_ev_bb, v_ev_hands, v_ev_win
            from fn_horse_tag_ev(p_day - 6) e
           where e.situation = v_situation and e.mirrored
           limit 1;
          select s.z, s.sd_est into v_ev_z, v_ev_sd
            from fn_horse_tag_ev_significance(p_day - 6) s
           where s.situation = v_situation
           limit 1;

          if v_ev_bb is not null and v_ev_bb >= 0 then
            v_findings := v_findings || jsonb_build_object(
              'severity','info','category','gto','code','leak_tag_spike_positive_ev',
              'title','Leak tag ' || r.tag || ' rose, and its mirrored situation is WINNING ' || v_ev_bb || 'bb per hand',
              'evidence', jsonb_build_object(
                'tag', r.tag,
                'situation', v_situation,
                'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2),
                'baseline_rate_per_1k', round(r.base_rate, 2),
                'baseline_days', r.tag_base_days,
                'day_hands', v_day_hands,
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands,
                'mirrored_win_rate', v_ev_win),
              'recommendation','Counted on the loss side alone this rose, which is what the spike threshold saw. Counted on BOTH sides over seven days it MAKES money, so the rise is the fleet reaching the spot more often, not the brain regressing into it. Do not tune away from it on this finding and do not open a league matchup for it. It becomes a real warning on its own the day fn_horse_tag_ev turns the situation negative.');
          elsif v_ev_bb is not null and v_ev_z is not null and v_ev_z > -3 then
            -- NEGATIVE IS NOT THE SAME AS LOSING (2026-09-27). See migration header.
            v_findings := v_findings || jsonb_build_object(
              'severity','info','category','gto','code','leak_tag_spike_unresolved',
              'title','Leak tag ' || r.tag || ' rose, but its mirrored EV (' || v_ev_bb || 'bb/hand, z ' || v_ev_z || ') is indistinguishable from zero',
              'evidence', jsonb_build_object(
                'tag', r.tag, 'situation', v_situation, 'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2), 'baseline_rate_per_1k', round(r.base_rate, 2),
                'mirrored_bb_per_hand', v_ev_bb, 'mirrored_hands', v_ev_hands,
                'mirrored_sd_est', v_ev_sd, 'mirrored_z', v_ev_z, 'z_gate', -3),
              'recommendation','The spot is arising more often, but seven days of both outcomes cannot tell it from breakeven. Do not tune on it and do not open a matchup for it. It becomes a warning the day its z falls to -3 or below.');
          else
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
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands),
              'recommendation','Rates are per 1,000 captured hands on both sides and the baseline counts only days this detector was live, so this is neither a volume artifact nor a new-detector artifact. mirrored_bb_per_hand is the seven-day EV across BOTH outcomes: negative confirms a real leak, and null means the situation has under 100 hands in the window or has no winning mirror (the fold family), so the rise is unexplained rather than confirmed. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
          end if;
        end;
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

  -- Tournament chips at changing blind levels are not cash-game bb EV.
  -- Keep both observations, with separate comparison cohorts and labels.
  for r in
    with results as (
      select horse_user_id,
        case when tournament_id is null then 'cash' else 'tournament' end as lane,
        sum(net_bb) as net, count(*) as n
      from horse_hand_reviews where played_at>=p_day and played_at<p_day+1
      group by horse_user_id, (tournament_id is null)
    )
    select horse_user_id,lane,round(net,1) as net,n from results hr
    where net < least(-400,(select percentile_cont(0.1) within group(order by f.net)
      from results f where f.lane=hr.lane))
    order by net limit 10
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity',case when r.lane='tournament' then 'info' when r.net < -800 then 'critical' else 'warn' end,
      'category','gto',
      'code',case when r.lane='tournament' then 'horse_tournament_big_pot_result' else 'horse_big_pot_bleed' end,
      'title','Horse lost ' || abs(r.net) || 'bb across ' || r.n || ' flagged ' || r.lane || ' pots',
      'evidence',jsonb_build_object('horse_user_id',r.horse_user_id,
        'alias',(select coalesce(alias,display_name,username) from profiles where id=r.horse_user_id),
        'net_bb',r.net,'hands',r.n,'format',r.lane,
        'tags',(select coalesce(jsonb_object_agg(tag,cnt),'{}'::jsonb) from (
          select tag,count(*) cnt from horse_hand_reviews,lateral unnest(leak_tags) tag
          where horse_user_id=r.horse_user_id and played_at>=p_day and played_at<p_day+1
            and (tournament_id is null)=(r.lane='cash') group by tag) t)),
      'recommendation',case when r.lane='tournament' then
        'This is a tournament chip result across changing blinds, not cash EV or proof of a style defect. Review commitment-street actions, starting stacks and tournament utility before changing a dial.'
        else 'Review this horse''s cash flagged hands and both outcome mirrors. A negative captured-pot total alone does not establish a style defect; inspect commitment-street decisions and the hand count.' end);
  end loop;

  for r in select matchup, bb100, stderr, illegal_actions from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
  loop
    if r.bb100 < 0 and abs(r.bb100) > 2 * r.stderr then
      v_findings := v_findings || jsonb_build_object('severity',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then 'info' else 'critical' end,
        'category','gto','code',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then 'league_inactive_layer_negative' else 'league_layer_negative' end,
        'title','League matchup ' || r.matchup || ' resolves NEGATIVE','evidence', jsonb_build_object('matchup',r.matchup,'bb100',r.bb100,'stderr',r.stderr),
        'recommendation',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then
        'V16Hu is default off in protected source. The on-arm lost; this supports retaining the default and is not evidence that production applies the layer. Recheck source defaults before proposing an ablation.'
        else 'A strategy layer is measurably losing money in self-play. Check its current default and candidate selection, then ablate any active layer properly before tuning.' end);
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

  for r in select id, horse_user_id, net_bb, game_variant, format, tournament_id, big_blind from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1
      and abs(net_bb) > (case when tournament_id is not null then 1500 else 500 end)
      order by abs(net_bb) desc limit 5
  loop
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','net_outlier',
      'title','Review row with |net| of ' || r.net_bb || 'bb','evidence', jsonb_build_object('review_id',r.id,'horse_user_id',r.horse_user_id,'net_bb',r.net_bb,'variant',r.game_variant,'format',r.format,'tournament_id',r.tournament_id,'big_blind',r.big_blind),
      'recommendation','Cross-check the captured pre-action stack, contributions and returns. Cash rebuy history and early tournament blind levels can legitimately produce deep bb stacks; a fixed bb threshold alone does not prove an accounting error.');
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
  -- 2026-09-27: the audit reports its own missing days. daily_audit claimed
  -- 2026-09-26 and wrote nothing, and no instrument said so.
  for r in
    select j.run_date, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.job = 'daily_audit'
       and j.run_date between p_day - 2 and p_day - 1
       and not exists (select 1 from horse_daily_audit x where x.day = j.run_date)
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity','critical','category','schema','code','daily_audit_lost',
      'title','daily_audit claimed ' || r.run_date || ' and never wrote its row',
      'evidence', jsonb_build_object('run_date', r.run_date, 'claimed_at', r.claimed_at, 'claimed_by', r.claimed_by),
      'recommendation','The engine calls this function as service_role, whose statement_timeout is 8s. Run select fn_run_horse_daily_audit(''' || r.run_date || '''::date) from a session with a longer timeout to recover the day, then find the step that outgrew 8s.');
  end loop;
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
  -- 2026-09-05 hardening: the tag registry, the tuner, the seat clock.
  v_findings := v_findings || fn_audit_tag_consumers(p_day);
  v_findings := v_findings || fn_audit_tuner_health(p_day);
  v_findings := v_findings || fn_audit_seat_clock(p_day);
  -- 2026-09-06: a receipt can be zero because the behaviour is broken OR
  -- because the world never presents the spot. Those want opposite fixes.
  v_findings := v_findings || fn_audit_behaviour_has_a_stage(p_day);
  -- 2026-09-05 V49: the leaks a 20bb loss cannot see.
  v_findings := v_findings || fn_audit_frequency_leaks(p_day);
  -- 2026-09-05 V47: the absolute score the league cannot produce.
  v_findings := v_findings || fn_audit_solver_agreement(p_day);
  -- 2026-09-08 Phase 4: certified corpus and independent pipeline liveness.
  v_findings := v_findings || fn_audit_gto_v31_certified(p_day);
  v_findings := v_findings || fn_audit_solver_pipeline_liveness(p_day);
  -- 2026-09-05: the tournament lane scoreboard, compiled for the day then judged.
  perform fn_horse_tournament_daily_compile(p_day);
  v_findings := v_findings || fn_audit_tournament_results(p_day);

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats,'{}'::jsonb), v_findings)
  on conflict (day) do update set generated_at = now(), stats = excluded.stats, findings = excluded.findings;

  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end
$function$;

REVOKE ALL ON FUNCTION public.fn_run_horse_daily_audit(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_horse_daily_audit(date) TO service_role;

COMMIT;
