CREATE OR REPLACE FUNCTION public.fn_spin_metrics(p_lag_window_minutes integer DEFAULT 60)
 RETURNS TABLE(reveal_spins bigint, reveal_p50_ms numeric, reveal_p90_ms numeric, reveal_p99_ms numeric, reveal_worst_ms integer, reveal_past_lead_in bigint, fairness_draws bigint, fairness_realised_e numeric, fairness_spec_e numeric, fairness_z numeric, fairness_drift boolean, fairness_constrained bigint, attribution_gaps bigint, unpaid_settlements bigint, booking_gaps bigint, unbooked_spins bigint, seconds_since_last_start numeric, open_boards bigint, unfilled_waits bigint, reserve_thin_clubs bigint, reserve_min_balance numeric)
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
  ub as (
    select count(*)::bigint as n
    from public.tournaments t
    where t.variant = 'spin'
      and t.status in ('RUNNING','COMPLETED')
      and coalesce(t.buy_in_fee, 0) = 0
      and coalesce(t.spin_multiplier, 0) > 0
      and t.club_id is not null
      and t.started_at > now() - interval '24 hours'
      and exists (select 1 from public.tournament_players tp
                   where tp.tournament_id = t.id)
      and not exists (select 1 from public.spin_reserve_ledger l
                       where l.tournament_id = t.id)
  ),
  /* LIVENESS. Not "are the running games healthy" - "is the fleet producing
     games at all". The 2026-09-01 outage was invisible to every other number
     here because they all measure games that exist. */
  live as (
    select
      round(extract(epoch from now() - max(t.started_at)))::numeric as secs_since_start
    from public.tournaments t
    where t.variant = 'spin'
  ),
  boards as (
    select count(*)::bigint as n
    from public.tournaments t
    where t.variant = 'spin' and t.status = 'REGISTERING'
  ),
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
    ub.n,
    live.secs_since_start,
    boards.n,
    (select count(*)::bigint from public.v_spin_unfilled_waits),
    coalesce(res.thin_clubs, 0),
    res.min_balance
  from lag
  cross join res
  cross join bg
  cross join ub
  cross join up
  cross join live
  cross join boards
  left join fair on true;
$function$
