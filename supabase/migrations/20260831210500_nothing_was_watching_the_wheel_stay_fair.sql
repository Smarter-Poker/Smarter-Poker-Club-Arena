-- ═══════════════════════════════════════════════════════════════════════════
--  NOTHING WAS WATCHING THE WHEEL STAY FAIR (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spin's whole commercial design rests on ONE equality:
--
--     E[multiplier] = seats x (1 - rake_rate) = 3 x 0.92126 = 2.7637726...
--
-- The rake is not charged. It is ENGINEERED INTO THE DISTRIBUTION. There is
-- no rake row to audit, no fee to reconcile, no ledger line that says "8%".
-- The only evidence the house is taking what it advertises is the mean of the
-- multipliers actually drawn.
--
-- Nothing measured it. `v_spin_draw_distribution_7d` shows per-tier counts vs
-- expectation, which is a shape check, not an edge check: a distribution can
-- be visibly "about right" tier by tier and still carry a materially wrong
-- mean, because 100x moves the mean 100x harder than 2x does. The 2026-08-31
-- audit computed the realised mean BY HAND (21,250 draws, E = 2.7628) and
-- that hand-computation was the only time in the platform's life that the
-- central promise of the format had ever been checked.
--
-- ── WHY A Z-SCORE AND NOT A TOLERANCE ─────────────────────────────────────
-- "Is it 2.7638?" is the wrong question and it is unanswerable: it never will
-- be exactly, and any fixed tolerance is wrong at one sample size or the
-- other. The multiplier's spec standard deviation is 1.6229, so at 22,000
-- draws the standard error of the mean is ~0.011 and at 2,000 draws it is
-- ~0.036 -- a 0.03 gap is unremarkable in a day and a screaming alarm in a
-- week. So the view reports how many standard errors the realised mean sits
-- from spec, and the drift flag is |z| >= 4 with a floor on sample size.
-- Four sigma is roughly a 1-in-16,000 false alarm per evaluation, which on a
-- gauge scraped every minute is the loosest threshold that will not page
-- somebody every week for nothing.
--
-- ── WHY constrained_draws EXISTS ──────────────────────────────────────────
-- `fn_spin_draw_multiplier` drops tiers the reserve pool cannot cover and
-- RENORMALISES over what is left. That is correct -- the alternative is
-- promising a 100x it cannot pay -- but it lowers the conditional mean while
-- the lockout lasts, so E falls and the effective edge rises above the
-- advertised 7.87% through no fault of the RNG. A drift alarm that could not
-- tell "the RNG is wrong" from "the pool was thin on Tuesday" would be worse
-- than no alarm, because the first explanation anyone reaches for would be
-- the wrong one. `constrained_draws` is that discriminator, and it reads 0
-- over the last 7 days on production today.

-- ── THE FAIRNESS VIEW ─────────────────────────────────────────────────────
create or replace view public.v_spin_draw_fairness as
with spec as (
  select
    sum(freq)::numeric                                        as total_freq,
    sum(multiplier::numeric * freq) / sum(freq)               as spec_e
  from public.spin_tier_spec
),
spec_sd as (
  select
    s.spec_e,
    sqrt(
      sum(t.freq * power(t.multiplier::numeric - s.spec_e, 2)) / s.total_freq
    ) as spec_sd
  from public.spin_tier_spec t
  cross join spec s
  group by s.spec_e, s.total_freq
),
windows(window_label, window_hours) as (
  values ('1h', 1), ('24h', 24), ('7d', 168)
),
drawn as (
  select
    w.window_label,
    w.window_hours,
    count(t.id)::bigint                                       as draws,
    avg(t.spin_multiplier)                                    as realised_e,
    count(*) filter (
      where jsonb_array_length(coalesce(t.spin_locked_tiers, '[]'::jsonb)) > 0
    )::bigint                                                 as constrained_draws
  from windows w
  left join public.tournaments t
    on t.variant = 'spin'
   and t.spin_multiplier is not null
   and t.spin_multiplier > 0
   and t.created_at >= now() - (w.window_hours || ' hours')::interval
  group by w.window_label, w.window_hours
)
select
  d.window_label,
  d.window_hours,
  d.draws,
  round(sd.spec_e, 6)                                         as spec_e,
  round(d.realised_e, 6)                                      as realised_e,
  round(sd.spec_sd, 6)                                        as spec_sd,
  -- Standard error of the mean at this sample size. NULL below 2 draws:
  -- a mean of one number has no error bar and must not read as agreement.
  case when d.draws >= 2
    then round(sd.spec_sd / sqrt(d.draws::numeric), 6)
  end                                                         as sem,
  case when d.draws >= 2 and sd.spec_sd > 0
    then round((d.realised_e - sd.spec_e) / (sd.spec_sd / sqrt(d.draws::numeric)), 3)
  end                                                         as z,
  -- The advertised edge and the one the players actually paid.
  round(100 * (1 - sd.spec_e / 3), 4)                         as spec_edge_pct,
  case when d.draws > 0
    then round(100 * (1 - d.realised_e / 3), 4)
  end                                                         as realised_edge_pct,
  d.constrained_draws,
  -- FAIL-CLOSED IS WRONG HERE AND FAIL-OPEN IS RIGHT. A window with too few
  -- draws is not evidence of a problem, it is absence of evidence, and a
  -- flag that fired on thin data would fire every night at 4am.
  (
    d.draws >= 2000
    and sd.spec_sd > 0
    and abs((d.realised_e - sd.spec_e) / (sd.spec_sd / sqrt(d.draws::numeric))) >= 4
  )                                                           as drift
from drawn d
cross join spec_sd sd
order by d.window_hours;

alter view public.v_spin_draw_fairness set (security_invoker = true);
revoke all on public.v_spin_draw_fairness from public;
revoke all on public.v_spin_draw_fairness from anon, authenticated;
grant select on public.v_spin_draw_fairness to service_role;

comment on view public.v_spin_draw_fairness is
  'Realised E[multiplier] against the 2.7637726 spec equality that Spin''s 8% rake IS. z = standard errors from spec; drift = |z| >= 4 on >= 2000 draws. constrained_draws separates a thin reserve pool from a broken RNG.';

-- ── ONE ROUND TRIP FOR THE ENGINE ─────────────────────────────────────────
-- The engine scrapes /metrics every 15s and must not run six queries to do
-- it. Everything the spin gauges need, in one plan, shaped so that a caller
-- gets numbers or an error -- never a tidy row of zeroes that reads as
-- health. (services/SpinMetrics.ts keeps the last good snapshot on failure
-- and lets poker_spin_metrics_stale_seconds tell the truth about it.)
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
    (select count(*)::bigint from public.v_spin_draw_booking_gaps),
    (select count(*)::bigint from public.v_spin_unfilled_waits),
    coalesce(res.thin_clubs, 0),
    res.min_balance
  from lag
  cross join res
  left join fair on true;
$$;

revoke all on function public.fn_spin_metrics(integer) from public;
revoke all on function public.fn_spin_metrics(integer) from anon, authenticated;
grant execute on function public.fn_spin_metrics(integer) to service_role;

comment on function public.fn_spin_metrics(integer) is
  'One round trip behind the poker_spin_* gauges: reveal-lag percentiles, draw fairness vs the 2.7638 spec equality, and every spin repair queue depth. service_role only.';
