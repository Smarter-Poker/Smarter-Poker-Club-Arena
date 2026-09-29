# SpinDrawFairnessDrift

Runbook for `SpinDrawFairnessDrift` in `infra/monitoring/spin-rules.yml`
(group `spin-fairness`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-fairness-drift`, which has never
served anything.

## What it means

```
poker_spin_draw_fairness_drift > 0   for: 15m   severity: critical
```

Spin charges no rake row; the house edge is engineered into the multiplier
distribution, so the product is one equality: the mean multiplier drawn equals
the mean of `spin_tier_spec`. The gauge is 1 when, over the last 24 hours, the
realised mean is four or more standard errors from spec over at least 2,000
draws (roughly a 1 in 16,000 false alarm). Below spec means players pay a
larger edge than advertised; above spec means the reserve pool is paying out
faster than buy-ins refill it.

## What the expression measures

`server/src/services/SpinMetrics.ts` calls `fn_spin_metrics(60)` once a
minute. Its `fairness_*` columns are the `24h` row of the view
`v_spin_draw_fairness`, which reads `tournaments` where `variant = 'spin'` and
`spin_multiplier > 0`, bucketed by `created_at`. `drift` is
`draws >= 2000 AND abs(z) >= 4`. The spec mean comes from `spin_tier_spec`
(read `spec_e` from the view; the 2.7637726 in older comments is not what the
table holds today). If fewer than 2,000 Spins were drawn in 24 hours the gauge
cannot be 1, however far the mean moves.

## First checks

1. Is the draw constrained? Read `poker_spin_draw_constrained` (or
   `constrained_draws` below). A thin reserve pool locks the top tiers out of
   the draw and renormalises, which lowers the mean through no fault of the RNG.
   Non-zero there is the explanation, and `SpinReservePoolThin` should be
   firing too (`docs/runbooks/spin-reserve-thin.md`).
2. The numbers, read-only:
   ```sql
   SELECT window_label, draws, spec_e, realised_e, sem, z, constrained_draws, drift
   FROM v_spin_draw_fairness ORDER BY window_hours;
   ```
3. The shape, when the mean moved and nothing was constrained:
   ```sql
   SELECT * FROM v_spin_draw_distribution_7d;
   SELECT * FROM spin_tier_spec ORDER BY multiplier;
   ```
   Compare per-tier counts with expectation. A shift concentrated in one tier
   points at the tier table or the draw function, not at chance.
4. Was `spin_tier_spec` changed recently? A change to the table moves `spec_e`
   for every window at once, including draws made under the old table. Check
   `supabase/migrations/` and `git log -- supabase/migrations | grep -i tier`.

## Likely causes

- Reserve pool thin in one or more clubs (constrained draws): expected
  behaviour, not a defect in the draw.
- The tier table was edited without the draw function's assumptions (or the
  reverse).
- A change to `fn_spin_draw_multiplier` or to the tier selection inside
  `fn_spin_draw_and_settle_atomic`.
- Genuine chance, which at `|z| >= 4` over 2,000+ draws is very unlikely.

## What not to do

- Do not adjust multipliers, tiers or prizes by hand to pull the mean back.
  Past draws are settled records (CLAUDE.md 10.9, immutable records).
- Do not test the draw by calling it against production. A money function is
  probed only inside one rolled-back `DO` block per call (11.5 rule 1).
- Do not silence the alert by raising the threshold. Find which of the causes
  above is true and fix that.

## Where the owning code lives

- Producer: `server/src/services/SpinMetrics.ts`; SQL `fn_spin_metrics`,
  last defined in
  `supabase/migrations/20260902020033_a_fleet_that_produces_nothing_looks_like_a_quiet_night.sql`.
- View: `v_spin_draw_fairness`; tier table `spin_tier_spec`.
- Draw: `fn_spin_draw_and_settle_atomic`, `fn_spin_draw_multiplier`; engine
  side `server/src/tournament/SpinDrawReceipt.ts` and `spinDrawSync.ts`.
- Hourly database-side check: pg_cron `spin_fairness_check_hourly`
  (`fn_spin_fairness_check(7)`).
