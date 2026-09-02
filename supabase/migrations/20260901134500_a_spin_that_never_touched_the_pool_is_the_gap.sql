-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOOKING-GAP GAUGE COULD NOT SEE A SPIN THAT WAS NEVER BOOKED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_spin_metrics.booking_gaps is guarded by `d.drawn is not null`. That makes
-- it ask one question only: of the Spins that WERE booked, did any pay out more
-- than they drew. A Spin with no spin_reserve_ledger row at all has
-- drawn = NULL and is excluded from the count entirely.
--
-- So the single number watching prize money leave the reserve pool read 0 for
-- two days while 112 Spins ran, drew, paid 5,737.00 in prizes and never touched
-- the pool at all -- because the backstop that books them
-- (fn_spin_sweep_unbooked, via /api/cron/spin-sweep) was dying on the
-- service_role statement timeout on every single run. Zero recorded as healthy.
-- Same shape as the 2026-08-27 horse-rake incident and the 2026-08-31
-- zero-attribution incident: the auditor cannot see the failure it exists for.
--
-- `unbooked_spins` is a SEPARATE number rather than folded into booking_gaps,
-- because "paid more than it drew" and "never touched the pool" are different
-- incidents with different first moves: the first is a settlement arithmetic
-- problem, the second means the backstop is not running.
--
-- Platform-wide this reads 0 in normal operation -- every Spin books inline at
-- settle time -- so an alert at > 0 is quiet by default and would have fired
-- within fifteen minutes of the 2026-08-30 regression.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_spin_metrics(integer);
--   -- then re-apply 20260831220000_the_gauge_stops_asking_the_unbounded_auditor.sql

DROP FUNCTION IF EXISTS public.fn_spin_metrics(integer);

CREATE FUNCTION public.fn_spin_metrics(p_lag_window_minutes integer DEFAULT 60)
RETURNS TABLE(
  reveal_spins bigint, reveal_p50_ms numeric, reveal_p90_ms numeric,
  reveal_p99_ms numeric, reveal_worst_ms integer, reveal_past_lead_in bigint,
  fairness_draws bigint, fairness_realised_e numeric, fairness_spec_e numeric,
  fairness_z numeric, fairness_drift boolean, fairness_constrained bigint,
  attribution_gaps bigint, unpaid_settlements bigint, booking_gaps bigint,
  unbooked_spins bigint,
  unfilled_waits bigint, reserve_thin_clubs bigint, reserve_min_balance numeric
)
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
  /* NEVER BOOKED AT ALL. Deliberately the same predicate the backstop sweeps
     on (fn_spin_sweep_unbooked), so the gauge and the repair cannot disagree
     about what "unbooked" means. Bounded to 24h for the same reason the
     unpaid-settlement count is: this is a 60-second scrape. */
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
    ub.n,
    (select count(*)::bigint from public.v_spin_unfilled_waits),
    coalesce(res.thin_clubs, 0),
    res.min_balance
  from lag
  cross join res
  cross join bg
  cross join ub
  cross join up
  left join fair on true;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_metrics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_metrics(integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_metrics(integer) IS
  'One row of Spin telemetry for the engine scrape. unbooked_spins counts a '
  'Spin that ran, drew and paid without ever touching the reserve pool -- the '
  'case booking_gaps is structurally blind to, because its `drawn is not null` '
  'guard only ever compared booked games against what they paid.';

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_spin_metrics(60);
  IF r.unbooked_spins IS NULL THEN
    RAISE EXCEPTION 'fn_spin_metrics did not return unbooked_spins';
  END IF;
  IF has_function_privilege('anon', 'public.fn_spin_metrics(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_spin_metrics(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_metrics is reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_spin_metrics(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_metrics is not reachable by service_role';
  END IF;
END $$;
