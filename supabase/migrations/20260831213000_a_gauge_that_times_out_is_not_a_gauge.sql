-- ═══════════════════════════════════════════════════════════════════════════
--  A GAUGE THAT TIMES OUT IS NOT A GAUGE (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_spin_metrics was correct and unusable. Called through PostgREST with the
-- service role - which is how the engine actually calls it, rather than
-- through the SQL editor where it was built and verified - it returned
--
--     57014: canceling statement due to statement timeout
--
-- every single time. A collector that always fails is worse than no
-- collector: SpinMetrics keeps its last good snapshot on failure, so on a
-- fresh engine boot the gauges would simply never appear, and
-- poker_spin_metrics_stale_seconds would sit at its 86,400 "never collected"
-- value while everybody assumed the fairness watch was running.
--
-- Caught by calling the RPC the way the engine calls it instead of the way it
-- was written. Two components were responsible.
--
-- ── 1. THE FAIRNESS VIEW SCANNED EVERY SPIN EVER RUN, THREE TIMES ─────────
-- Joining a VALUES list of windows to `tournaments` turned the time bound
-- into a JOIN FILTER, which no index can serve: 7.4s, a sequential scan of
-- 53,613 rows materialised and re-read once per window. The windows are
-- nested, so one pass with FILTER aggregates answers all three, and the pass
-- is now bounded by the widest window and served by a partial index.
--
-- ── 2. THE BOOKING-GAP COUNT AGGREGATED FOUR YEARS OF LEDGER ─────────────
-- `count(*) from v_spin_draw_booking_gaps` is 12.5s on its own: the view
-- groups the whole spin_reserve_ledger and every prize credit in
-- wallet_transactions before filtering down to 11 rows. That is the right
-- shape for a human auditing history and the wrong shape for a gauge scraped
-- every minute.
--
-- The alert only ever cared about NEW gaps, so the gauge now counts gaps
-- among spins that ENDED IN THE LAST 24 HOURS, starting from the small set of
-- recent tournaments and looking each one up through indexes that already
-- exist. The full view is unchanged and still the right tool for the history.
--
-- That also lets the alert rule drop `delta()` for a plain `> 0`, which is
-- strictly better: delta() over a gauge cannot tell a genuine new gap from
-- the counter resetting on an engine restart.

-- ── INDEXES THE BOUNDED SCANS NEED ───────────────────────────────────────
create index if not exists idx_tournaments_spin_draws
  on public.tournaments (created_at desc)
  include (spin_multiplier, spin_locked_tiers)
  where variant = 'spin' and spin_multiplier is not null;

create index if not exists idx_tournaments_spin_ended
  on public.tournaments (ended_at desc)
  where variant = 'spin' and spin_multiplier is not null and ended_at is not null;

-- ── ONE PASS, THREE WINDOWS ──────────────────────────────────────────────
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
/* ONE bounded pass. The windows nest, so every narrower one is a FILTER on
   the widest rather than another scan. */
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

-- ── THE RPC, WITHIN A SCRAPE'S BUDGET ────────────────────────────────────
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
  /* NEW booking gaps only, and bounded. Same predicate as
     v_spin_draw_booking_gaps, driven from the handful of spins that ended
     recently instead of from four years of ledger. */
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
