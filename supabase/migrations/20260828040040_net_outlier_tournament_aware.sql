-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828040040; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- NET OUTLIER - KNOW THAT TOURNAMENT CHIPS ARE DEEP (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-creates fn_run_horse_daily_audit from 20260828a with ONE change: the
-- net_outlier detector's threshold is tournament-aware. Traced by the Phase 2
-- session: review ids 9950/9957/9964/10014/10020 were all tournament hands
-- where net_amount was exactly consistent with pot_size - not a capture bug.

create or replace function fn_run_horse_daily_audit(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '60s'
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
      base_tags as (
        select tag, count(*) cnt
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day - 7 and played_at < p_day
         group by tag
      )
      select d.tag,
             d.cnt,
             (d.cnt::numeric * 1000) / v_day_hands                as day_rate,
             (coalesce(b.cnt, 0)::numeric * 1000) / v_base_hands  as base_rate
        from day_tags d
        left join base_tags b using (tag)
       where d.cnt >= 20
         and (coalesce(b.cnt, 0) = 0
              or (d.cnt::numeric * 1000) / v_day_hands
                 > ((b.cnt::numeric * 1000) / v_base_hands) * 1.5)
    loop
      v_findings := v_findings || jsonb_build_object(
        'severity', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5 then 'critical' else 'warn' end,
        'category','logic','code','leak_tag_spike',
        'title','Leak tag ' || r.tag || ' spiked',
        'evidence', jsonb_build_object(
          'tag', r.tag,
          'count', r.cnt,
          'rate_per_1k', round(r.day_rate, 2),
          'baseline_rate_per_1k', round(r.base_rate, 2),
          'baseline_days', v_base_days,
          'day_hands', v_day_hands,
          'baseline_hands', v_base_hands),
        'recommendation','Rates are per 1,000 captured hands on both sides, so this is not a volume artifact. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
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

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats,'{}'::jsonb), v_findings)
  on conflict (day) do update set generated_at = now(), stats = excluded.stats, findings = excluded.findings;
  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end
$function$;

revoke all on function fn_run_horse_daily_audit(date) from public, anon, authenticated;
grant execute on function fn_run_horse_daily_audit(date) to service_role;
