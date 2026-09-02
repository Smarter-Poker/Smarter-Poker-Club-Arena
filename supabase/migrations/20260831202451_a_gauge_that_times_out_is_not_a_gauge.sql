-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831202451; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create index if not exists idx_tournaments_spin_draws
  on public.tournaments (created_at desc)
  include (spin_multiplier, spin_locked_tiers)
  where variant = 'spin' and spin_multiplier is not null;

create index if not exists idx_tournaments_spin_ended
  on public.tournaments (ended_at desc)
  where variant = 'spin' and spin_multiplier is not null and ended_at is not null;

create or replace view public.v_spin_draw_fairness as
with spec as (
  select
    sum(freq)::numeric                          as total_freq,
    sum(multiplier::numeric * freq) / sum(freq) as spec_e
  from public.spin_tier_spec
),
spec_sd as (
  select
    s.spec_e,
    sqrt(sum(t.freq * power(t.multiplier::numeric - s.spec_e, 2)) / s.total_freq) as spec_sd
  from public.spin_tier_spec t
  cross join spec s
  group by s.spec_e, s.total_freq
),
agg as (
  select
    count(*) filter (where created_at >= now() - interval '1 hour')                 as d1,
    avg(spin_multiplier) filter (where created_at >= now() - interval '1 hour')     as e1,
    count(*) filter (where created_at >= now() - interval '1 hour'
                       and jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c1,
    count(*) filter (where created_at >= now() - interval '24 hours')               as d24,
    avg(spin_multiplier) filter (where created_at >= now() - interval '24 hours')   as e24,
    count(*) filter (where created_at >= now() - interval '24 hours'
                       and jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c24,
    count(*)                                                                       as d7,
    avg(spin_multiplier)                                                           as e7,
    count(*) filter (where jsonb_array_length(coalesce(spin_locked_tiers, '[]'::jsonb)) > 0) as c7
  from public.tournaments
  where variant = 'spin'
    and spin_multiplier is not null
    and spin_multiplier > 0
    and created_at >= now() - interval '168 hours'
),
shaped as (
  select '1h'::text as window_label,  1 as window_hours, d1::bigint  as draws, e1  as realised_e, c1::bigint  as constrained_draws from agg
  union all
  select '24h',                      24,               d24::bigint,           e24,              c24::bigint            from agg
  union all
  select '7d',                      168,               d7::bigint,            e7,               c7::bigint             from agg
)
select
  d.window_label,
  d.window_hours,
  d.draws,
  round(sd.spec_e, 6)                                 as spec_e,
  round(d.realised_e, 6)                              as realised_e,
  round(sd.spec_sd, 6)                                as spec_sd,
  case when d.draws >= 2 then round(sd.spec_sd / sqrt(d.draws::numeric), 6) end as sem,
  case when d.draws >= 2 and sd.spec_sd > 0
    then round((d.realised_e - sd.spec_e) / (sd.spec_sd / sqrt(d.draws::numeric)), 3)
  end                                                 as z,
  round(100 * (1 - sd.spec_e / 3), 4)                 as spec_edge_pct,
  case when d.draws > 0 then round(100 * (1 - d.realised_e / 3), 4) end as realised_edge_pct,
  d.constrained_draws,
  (
    d.draws >= 2000
    and sd.spec_sd > 0
    and abs((d.realised_e - sd.spec_e) / (sd.spec_sd / sqrt(d.draws::numeric))) >= 4
  )                                                   as drift
from shaped d
cross join spec_sd sd
order by d.window_hours;

alter view public.v_spin_draw_fairness set (security_invoker = true);
revoke all on public.v_spin_draw_fairness from public;
revoke all on public.v_spin_draw_fairness from anon, authenticated;
grant select on public.v_spin_draw_fairness to service_role;

comment on view public.v_spin_draw_fairness is
  'Realised E[multiplier] against the 2.7637726 spec equality that Spin''s 8% rake IS. z = standard errors from spec; drift = |z| >= 4 on >= 2000 draws. constrained_draws separates a thin reserve pool from a broken RNG. One bounded pass over the 7d window; the narrower windows are FILTER aggregates on it.';

create or replace function public.fn_spin_metrics(
  p_lag_window_minutes integer default 60
)
returns table (
  reveal_spins            bigint,
  reveal_p50_ms           numeric,
  reveal_p90_ms           numeric,
  reveal_p99_ms           numeric,
  reveal_worst_ms         integer,
  reveal_past_lead_in     bigint,
  fairness_draws          bigint,
  fairness_realised_e     numeric,
  fairness_spec_e         numeric,
  fairness_z              numeric,
  fairness_drift          boolean,
  fairness_constrained    bigint,
  attribution_gaps        bigint,
  unpaid_settlements      bigint,
  booking_gaps            bigint,
  unfilled_waits          bigint,
  reserve_thin_clubs      bigint,
  reserve_min_balance     numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lag as (
    select
      count(*)::bigint as spins,
      round(percentile_cont(0.5) within group (order by spin_reveal_lag_ms::float8)::numeric) as p50,
      round(percentile_cont(0.9) within group (order by spin_reveal_lag_ms::float8)::numeric) as p90,
      round(percentile_cont(0.99) within group (order by spin_reveal_lag_ms::float8)::numeric) as p99,
      max(spin_reveal_lag_ms) as worst,
      count(*) filter (where spin_reveal_lag_ms > 1000)::bigint as past_lead_in
    from public.tournaments
    where variant = 'spin'
      and spin_reveal_lag_ms is not null
      and started_at > now() - (greatest(p_lag_window_minutes, 1) || ' minutes')::interval
  ),
  fair as (
    select draws, realised_e, spec_e, z, drift, constrained_draws
    from public.v_spin_draw_fairness
    where window_label = '24h'
  ),
  res as (
    select
      count(*) filter (where is_thin)::bigint as thin_clubs,
      min(balance) as min_balance
    from public.v_spin_reserve_health
  ),
  bg as (
    select count(*)::bigint as n
    from public.tournaments t
    where t.variant = 'spin'
      and t.spin_multiplier is not null
      and t.ended_at > now() - interval '24 hours'
      and exists (
        select 1
        from (
          select sum(-l.amount) as drawn
          from public.spin_reserve_ledger l
          where l.tournament_id = t.id and l.kind = 'jackpot_draw'
        ) d,
        (
          select sum(w.amount) as paid
          from public.wallet_transactions w
          where w.related_entity_id = t.id and w.type = 'credit' and w.category = 'prize'
        ) p
        where d.drawn is not null
          and p.paid is not null
          and p.paid > d.drawn
          and p.paid = round(t.buy_in_amount * t.spin_multiplier, 2)
      )
  )
  select
    coalesce(lag.spins, 0),
    lag.p50, lag.p90, lag.p99, lag.worst,
    coalesce(lag.past_lead_in, 0),
    coalesce(fair.draws, 0),
    fair.realised_e,
    fair.spec_e,
    fair.z,
    coalesce(fair.drift, false),
    coalesce(fair.constrained_draws, 0),
    (select count(*)::bigint from public.v_tournament_rake_attribution_gaps),
    (select count(*)::bigint from public.v_spin_unpaid_settlements),
    bg.n,
    (select count(*)::bigint from public.v_spin_unfilled_waits),
    coalesce(res.thin_clubs, 0),
    res.min_balance
  from lag
  cross join res
  cross join bg
  left join fair on true;
$$;

revoke all on function public.fn_spin_metrics(integer) from public;
revoke all on function public.fn_spin_metrics(integer) from anon, authenticated;
grant execute on function public.fn_spin_metrics(integer) to service_role;

comment on function public.fn_spin_metrics(integer) is
  'One round trip behind the poker_spin_* gauges: reveal-lag percentiles, draw fairness vs the 2.7638 spec equality, and every spin repair queue depth. booking_gaps counts only spins that ENDED in the last 24h, so a scrape never aggregates four years of ledger. service_role only.';
