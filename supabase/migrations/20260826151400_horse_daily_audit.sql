-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151400; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HORSE DAILY AUDIT (Dan 2026-08-26)
-- See supabase/migrations/20260826151309_horse_daily_audit.sql in the repo.

create table if not exists public.horse_daily_audit (
  day               date primary key,
  generated_at      timestamptz not null default now(),
  stats             jsonb not null default '{}'::jsonb,
  findings          jsonb not null default '[]'::jsonb,
  agent_analysis    jsonb,
  agent_analyzed_at timestamptz
);

comment on table public.horse_daily_audit is
  'Per-day audit of horse decision quality: machine findings from fn_run_horse_daily_audit (engine nightly job), plus the daily Claude deep-analysis in agent_analysis. Admin UI: smarter.poker/horses/hand-reviews.';

alter table public.horse_daily_audit enable row level security;

create or replace function public.fn_run_horse_daily_audit(p_day date)
returns jsonb
language plpgsql security definer
set search_path = public
set statement_timeout = '60s'
as $$
declare
  v_stats jsonb;
  v_findings jsonb := '[]'::jsonb;
  f jsonb;
  r record;
begin
  select jsonb_build_object(
    'flagged_hands', count(*),
    'big_wins', count(*) filter (where is_win),
    'big_losses', count(*) filter (where not is_win),
    'net_bb_sum', round(coalesce(sum(net_bb), 0), 1),
    'by_variant', coalesce((
      select jsonb_object_agg(game_variant, cnt) from (
        select game_variant, count(*) cnt from horse_hand_reviews
        where played_at >= p_day and played_at < p_day + 1
        group by game_variant
      ) v
    ), '{}'::jsonb),
    'by_format', coalesce((
      select jsonb_object_agg(format, cnt) from (
        select format, count(*) cnt from horse_hand_reviews
        where played_at >= p_day and played_at < p_day + 1
        group by format
      ) v
    ), '{}'::jsonb)
  ) into v_stats
  from horse_hand_reviews
  where played_at >= p_day and played_at < p_day + 1;

  for r in
    with day_tags as (
      select tag, count(*) cnt
      from horse_hand_reviews, lateral unnest(leak_tags) tag
      where played_at >= p_day and played_at < p_day + 1
      group by tag
    ),
    week_tags as (
      select tag, count(*) / 7.0 avg_cnt
      from horse_hand_reviews, lateral unnest(leak_tags) tag
      where played_at >= p_day - 7 and played_at < p_day
      group by tag
    )
    select d.tag, d.cnt, coalesce(w.avg_cnt, 0) avg_cnt
    from day_tags d left join week_tags w using (tag)
    where d.cnt >= 20 and (w.avg_cnt is null or d.cnt > w.avg_cnt * 1.5)
  loop
    f := jsonb_build_object(
      'severity', case when r.avg_cnt = 0 or r.cnt > r.avg_cnt * 2.5 then 'critical' else 'warn' end,
      'category', 'logic',
      'code', 'leak_tag_spike',
      'title', 'Leak tag ' || r.tag || ' spiked',
      'evidence', jsonb_build_object('tag', r.tag, 'count', r.cnt, 'trailing_7d_avg', round(r.avg_cnt::numeric, 1)),
      'recommendation', 'A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.'
    );
    v_findings := v_findings || f;
  end loop;

  for r in
    select horse_user_id, round(sum(net_bb), 1) net, count(*) n
    from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1
    group by horse_user_id
    having sum(net_bb) < -400
    order by sum(net_bb) asc
    limit 10
  loop
    f := jsonb_build_object(
      'severity', case when r.net < -800 then 'critical' else 'warn' end,
      'category', 'gto',
      'code', 'horse_big_pot_bleed',
      'title', 'Horse lost ' || abs(r.net) || 'bb across ' || r.n || ' flagged pots',
      'evidence', jsonb_build_object(
        'horse_user_id', r.horse_user_id,
        'alias', (select coalesce(alias, display_name, username) from profiles where id = r.horse_user_id),
        'net_bb', r.net, 'hands', r.n,
        'tags', (
          select coalesce(jsonb_object_agg(tag, cnt), '{}'::jsonb) from (
            select tag, count(*) cnt from horse_hand_reviews, lateral unnest(leak_tags) tag
            where horse_user_id = r.horse_user_id and played_at >= p_day and played_at < p_day + 1
            group by tag
          ) t
        )
      ),
      'recommendation', 'Review this horse''s flagged hands. Repeated identical tags mean a style/dial problem for the self-tuner; scattered tags with big losses can be variance - check the hand count first.'
    );
    v_findings := v_findings || f;
  end loop;

  for r in
    select matchup, bb100, stderr, illegal_actions
    from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
  loop
    if r.bb100 < 0 and abs(r.bb100) > 2 * r.stderr then
      f := jsonb_build_object(
        'severity', 'critical',
        'category', 'gto',
        'code', 'league_layer_negative',
        'title', 'League matchup ' || r.matchup || ' resolves NEGATIVE',
        'evidence', jsonb_build_object('matchup', r.matchup, 'bb100', r.bb100, 'stderr', r.stderr),
        'recommendation', 'A strategy layer is measurably losing money in self-play. Ablate it properly before tuning anything else (2026-08-23 measurement rules).'
      );
      v_findings := v_findings || f;
    end if;
    if r.illegal_actions > 0 then
      f := jsonb_build_object(
        'severity', 'critical',
        'category', 'logic',
        'code', 'league_illegal_actions',
        'title', 'League matchup ' || r.matchup || ' produced illegal actions',
        'evidence', jsonb_build_object('matchup', r.matchup, 'illegal_actions', r.illegal_actions),
        'recommendation', 'The brain emitted a sizing the engine rejects. This reaches live tables as silent check/fold degradation - find the exact branch.'
      );
      v_findings := v_findings || f;
    end if;
  end loop;

  for r in
    select h.game_variant, count(*) big_pots
    from hand_history h
    where h.created_at >= p_day and h.created_at < p_day + 1
      and h.pot_size >= 40 * h.big_blind
      and not exists (
        select 1 from horse_hand_reviews rv
        where rv.game_variant = h.game_variant
          and rv.played_at >= p_day and rv.played_at < p_day + 1
      )
    group by h.game_variant
    having count(*) >= 50
  loop
    f := jsonb_build_object(
      'severity', 'critical',
      'category', 'schema',
      'code', 'capture_coverage_gap',
      'title', 'Variant ' || r.game_variant || ' dealt ' || r.big_pots || ' big pots but wrote zero review rows',
      'evidence', jsonb_build_object('game_variant', r.game_variant, 'big_pot_hands', r.big_pots),
      'recommendation', 'recordHorseHandReviews is not firing for this variant''s settlement path, or its roster/contribution inputs are missing. Read the engine logs for HorseHandReview reportError entries.'
    );
    v_findings := v_findings || f;
  end loop;

  select count(*) into r from horse_hand_reviews
  where played_at >= p_day and played_at < p_day + 1
    and (hole_cards is null or board is null);
  if (r.count) >= 25 then
    f := jsonb_build_object(
      'severity', 'warn',
      'category', 'schema',
      'code', 'evidence_payload_missing',
      'title', (r.count) || ' review rows missing hole_cards or board',
      'evidence', jsonb_build_object('rows', r.count),
      'recommendation', 'parseCards rejected the payload shape, or preflop-only pots legitimately have no board. Sample the rows; if the shapes changed upstream the parser needs updating.'
    );
    v_findings := v_findings || f;
  end if;

  for r in
    select id, horse_user_id, net_bb, game_variant
    from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1 and abs(net_bb) > 500
    order by abs(net_bb) desc limit 5
  loop
    f := jsonb_build_object(
      'severity', 'warn',
      'category', 'schema',
      'code', 'net_outlier',
      'title', 'Review row with |net| of ' || r.net_bb || 'bb',
      'evidence', jsonb_build_object('review_id', r.id, 'horse_user_id', r.horse_user_id, 'net_bb', r.net_bb, 'variant', r.game_variant),
      'recommendation', 'Legitimate only for very deep stacks. If the stake caps make this impossible, the contribution/winner inputs disagree - an accounting flaw worth tracing to the hand.'
    );
    v_findings := v_findings || f;
  end loop;

  select count(*) into r from horse_hand_reviews
  where played_at >= p_day and played_at < p_day + 1
    and not is_win and leak_tags = '{}';
  if (r.count) >= 200 then
    f := jsonb_build_object(
      'severity', 'info',
      'category', 'logic',
      'code', 'untagged_losses',
      'title', (r.count) || ' big losses carry no leak tag',
      'evidence', jsonb_build_object('rows', r.count),
      'recommendation', 'Not every big loss is a mistake - but if manual review keeps finding the same untagged flaw, add a detector for it so it counts.'
    );
    v_findings := v_findings || f;
  end if;

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats, '{}'::jsonb), v_findings)
  on conflict (day) do update
    set generated_at = now(), stats = excluded.stats, findings = excluded.findings;

  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end $$;

revoke all on function public.fn_run_horse_daily_audit(date) from public;
grant execute on function public.fn_run_horse_daily_audit(date) to service_role;

create or replace function public.fn_horse_audit_set_agent_analysis(p_day date, p_analysis jsonb)
returns void
language sql security definer set search_path = public as $$
  update horse_daily_audit
  set agent_analysis = p_analysis, agent_analyzed_at = now()
  where day = p_day;
$$;
revoke all on function public.fn_horse_audit_set_agent_analysis(date, jsonb) from public;
grant execute on function public.fn_horse_audit_set_agent_analysis(date, jsonb) to service_role;

create or replace function public.ca_horse_daily_audit(p_days int default 14)
returns setof public.horse_daily_audit
language plpgsql security definer set search_path = public stable as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select * from horse_daily_audit
    where day > current_date - least(greatest(coalesce(p_days, 14), 1), 90)
    order by day desc;
end $$;
revoke all on function public.ca_horse_daily_audit(int) from public;
grant execute on function public.ca_horse_daily_audit(int) to authenticated, service_role;
