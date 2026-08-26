-- ═══════════════════════════════════════════════════════════════════════════
-- BRAIN TELEMETRY — proof of receipt (Dan 2026-08-26)
--
-- "Verify that all changes we make to the brain ACTUALLY MAKE IT to the
--  horses - that they receive, utilize and improve on the new logic."
--
-- Live decisions stamp the layers that actually EXECUTED (engine/
-- BrainTelemetry.ts, gated so league/benchmark/test decisions never count);
-- the engine flushes per-day fire counters here every minute. The daily
-- audit gains a layer_silent finding: a deployed layer with zero fires on a
-- day the fleet made thousands of decisions is a wiring regression and gets
-- flagged CRITICAL automatically. The admin panel reads ca_brain_telemetry.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.horse_brain_telemetry (
  day        date not null,
  feature    text not null,
  fires      bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, feature)
);

comment on table public.horse_brain_telemetry is
  'Per-day fire counts of brain layers at LIVE tables only (engine/BrainTelemetry.ts). Proof that deployed logic executes. layer_silent audit findings and the /horses/hand-reviews panel read this.';

alter table public.horse_brain_telemetry enable row level security;

create or replace function public.fn_brain_telemetry_add(p_day date, p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when r->>'feature' is null or length(r->>'feature') = 0 or length(r->>'feature') > 64;
    insert into horse_brain_telemetry as t (day, feature, fires)
    values (p_day, r->>'feature', coalesce((r->>'fires')::bigint, 0))
    on conflict (day, feature) do update set
      fires = t.fires + excluded.fires,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.fn_brain_telemetry_add(date, jsonb) from public;
grant execute on function public.fn_brain_telemetry_add(date, jsonb) to service_role;

create or replace function public.ca_brain_telemetry(p_days int default 7)
returns setof public.horse_brain_telemetry
language plpgsql security definer set search_path = public stable as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select * from horse_brain_telemetry
    where day > current_date - least(greatest(coalesce(p_days, 7), 1), 60)
    order by day desc, fires desc;
end $$;
revoke all on function public.ca_brain_telemetry(int) from public;
grant execute on function public.ca_brain_telemetry(int) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Audit v2: the layer_silent finding. A deployed layer that stopped firing
-- is indistinguishable from a working one without this — the house failure
-- mode, instrumented. Appended to fn_run_horse_daily_audit's findings.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.fn_audit_layer_silence(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  f jsonb;
  feat record;
begin
  select coalesce(sum(fires), 0) into v_decides
  from horse_brain_telemetry where day = p_day and feature = 'decide';

  -- No decision volume recorded at all: either telemetry itself is dead or
  -- the engine was down. Both deserve a critical.
  if v_decides < 1000 then
    return jsonb_build_array(jsonb_build_object(
      'severity', 'critical',
      'category', 'schema',
      'code', 'telemetry_dark',
      'title', 'Brain telemetry recorded ' || v_decides || ' decisions for ' || p_day,
      'evidence', jsonb_build_object('decide_fires', v_decides),
      'recommendation', 'Either BrainTelemetryFlush is not running (check engine logs for the flush service), the deploy predates telemetry, or the fleet was down. Nothing about layer health can be known for this day.'
    ));
  end if;

  -- Layers that MUST fire on any normal day of fleet play. Severity reflects
  -- how certainly zero means broken: always-on layers are critical; layers
  -- needing accumulated read samples start as warn.
  for feat in
    select * from (values
      ('preflop_v7',        'critical', 'the V7 preflop engine - every preflop decision should route through it'),
      ('v15_nut_status',    'critical', 'V15 Omaha nut awareness - fires on every made flush/straight in PLO'),
      ('banded_mc_omaha',   'critical', 'Omaha banded equity (the reservoir sampler feeds this path)'),
      ('banded_mc_nlh',     'critical', 'NLH banded equity'),
      ('icm_real',          'warn',     'V16 real ICM - fires on tournament decisions when the context carries stacks+payouts'),
      ('v16_hu_overlay',    'warn',     'V16 heads-up overlay - fires whenever a pot is two-handed postflop'),
      ('v15_eq_capped',     'warn',     'V15 equity cap - fires when dominated hands face aggression'),
      ('v16_reads_cbet',    'warn',     'deep-read c-bet scaling - needs 10+ observed c-bet opportunities per opponent'),
      ('v16_sizecond_bigbet', 'warn',   'size-conditioned sampling - fires when a 20bb+ bet is on the newest street')
    ) as t(feature, severity, why)
  loop
    if not exists (
      select 1 from horse_brain_telemetry
      where day = p_day and feature = feat.feature and fires > 0
    ) then
      f := jsonb_build_object(
        'severity', feat.severity,
        'category', 'logic',
        'code', 'layer_silent',
        'title', 'Deployed layer ' || feat.feature || ' fired ZERO times',
        'evidence', jsonb_build_object('feature', feat.feature, 'decide_fires', v_decides, 'expectation', feat.why),
        'recommendation', 'The code is deployed but never executes at live tables. Find the gate that turned it off - flag defaults, wiring, or an upstream condition that can no longer be true.'
      );
      v_findings := v_findings || f;
    end if;
  end loop;

  return v_findings;
end $$;
revoke all on function public.fn_audit_layer_silence(date) from public;
grant execute on function public.fn_audit_layer_silence(date) to service_role;

-- Re-create the daily audit to append layer-silence findings.
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
    ), '{}'::jsonb),
    'decides', (select coalesce(sum(fires),0) from horse_brain_telemetry where day = p_day and feature = 'decide'),
    'net_bb_all_hands', (select round(coalesce(sum(net_bb),0),1) from horse_daily_nets where day = p_day)
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

  -- ── PROOF OF RECEIPT: deployed-but-silent layers (audit v2) ──
  v_findings := v_findings || fn_audit_layer_silence(p_day);

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats, '{}'::jsonb), v_findings)
  on conflict (day) do update
    set generated_at = now(), stats = excluded.stats, findings = excluded.findings;

  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end $$;
