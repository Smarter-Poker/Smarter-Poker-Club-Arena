-- ═══════════════════════════════════════════════════════════════════════════
--  THE GAUGE STOPS ASKING THE UNBOUNDED AUDITOR (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_spin_metrics counted v_spin_unpaid_settlements directly. That view is the
-- unbounded historical auditor and measures 2.4s even after 20260831214500's
-- covering indexes took it down from 10.5s, which made a gauge scraped every
-- 60 seconds fail intermittently at the 8s statement timeout:
--
--     http=200 t=6.26s
--     http=500 t=11.62s   <- 57014
--     http=200 t=11.09s
--
-- An intermittently failing collector is the worst kind: SpinMetrics keeps its
-- last good snapshot on failure, so the gauges would have gone quietly stale
-- while still reading like live numbers.
--
-- The alert only ever cared about a prize that went missing RECENTLY, so the
-- gauge asks fn_spin_unpaid_settlements(24) - the same predicate over a
-- 24-hour window, deliberately wider than the 6 hours the repair itself
-- sweeps so it can still see anything the repair failed to fix.
--
-- Verified: 6 of 6 calls succeed, 2.2s to 8.0s.

CREATE OR REPLACE FUNCTION public.fn_spin_metrics(p_lag_window_minutes integer DEFAULT 60)
 RETURNS TABLE(reveal_spins bigint, reveal_p50_ms numeric, reveal_p90_ms numeric, reveal_p99_ms numeric, reveal_worst_ms integer, reveal_past_lead_in bigint, fairness_draws bigint, fairness_realised_e numeric, fairness_spec_e numeric, fairness_z numeric, fairness_drift boolean, fairness_constrained bigint, attribution_gaps bigint, unpaid_settlements bigint, booking_gaps bigint, unfilled_waits bigint, reserve_thin_clubs bigint, reserve_min_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  ),
  /* BOUNDED. This asked v_spin_unpaid_settlements - the unbounded auditor -
     which measures 2.4s and made a 60s-cadence scrape fail intermittently at
     the 8s statement timeout. The alert only ever cared about a prize that
     went missing recently. */
  up as (
    select count(*)::bigint as n
    from public.fn_spin_unpaid_settlements(24)
    where chips_short > 0.01
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
    up.n,
    bg.n,
    (select count(*)::bigint from public.v_spin_unfilled_waits),
    coalesce(res.thin_clubs, 0),
    res.min_balance
  from lag
  cross join res
  cross join bg
  cross join up
  left join fair on true;
$function$

revoke all on function public.fn_spin_metrics(integer) from public;
revoke all on function public.fn_spin_metrics(integer) from anon, authenticated;
grant execute on function public.fn_spin_metrics(integer) to service_role;

comment on function public.fn_spin_metrics(integer) is
  'One round trip behind the poker_spin_* gauges: reveal-lag percentiles, draw fairness vs the 2.7638 spec equality, and every spin repair queue depth. Every component is bounded, so a scrape never aggregates four years of ledger. service_role only.';
