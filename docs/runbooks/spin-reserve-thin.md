# SpinReservePoolThin

Runbook for `SpinReservePoolThin` in `infra/monitoring/spin-rules.yml` (group
`spin-experience`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-reserve-thin`, which has never
served anything.

## What it means

```
poker_spin_reserve_thin_clubs > 0   for: 30m   severity: warning
```

At least one Spin reserve pool holds less than ten times its highest stake, so
it cannot cover the top multipliers. The draw locks those tiers out and
renormalises over the rest. That is the correct behaviour (the alternative is
promising a prize the pool cannot pay), but the lobby still advertises the top
prize, and the realised mean multiplier falls below spec for as long as it
lasts, so `SpinDrawFairnessDrift` may follow.

## What the expression measures

`fn_spin_metrics` counts rows of `v_spin_reserve_health` where `is_thin`, which
is `balance < highest_stake * 10`, per row of `spin_bonus_pools`.
`can_draw_100x` is the stricter `balance >= highest_stake * 100 * 1.5`.
`poker_spin_reserve_min_balance` is the lowest pool balance. Measured
2026-09-26 06:45 UTC: 0 thin, minimum balance 17,049.90.

## First checks

1. Which pools, read-only:
   ```sql
   SELECT club_id, club_name, balance, highest_stake, need_for_100x, can_draw_100x,
          is_thin, seeded_amount, total_deposited, total_drawn, spin_count,
          shortfall_events, unbooked_24h
   FROM v_spin_reserve_health
   ORDER BY is_thin DESC, balance;
   ```
2. How fast is it draining? The ledger for that pool owner over the last day:
   ```sql
   SELECT kind, count(*), sum(amount)
   FROM spin_reserve_ledger
   WHERE fn_spin_reserve_owner(club_id) = '<club_id>'
     AND created_at > now() - interval '24 hours'
   GROUP BY kind;
   ```
   Draws out running ahead of buy-ins in is ordinary variance for a young pool
   and a problem for an old one.
3. Did `highest_stake` rise? A new, larger Spin stake raises the bar without
   the balance moving.
4. Are draws constrained? `poker_spin_draw_constrained` and
   `constrained_draws` in `v_spin_draw_fairness`.

## What to do

Topping up a pool moves real chips and is the pool owner's decision. The
funding door is `fn_spin_reserve_wallet_fund(p_union_id, p_amount,
p_from_wallet, p_note)`, which journals the deposit; the alternative is to
accept the lockout and expect the fairness gauge to move. Either way, record
what was decided.

## What not to do

- Do not update `spin_bonus_pools.balance` directly or hand-insert
  `spin_reserve_ledger` rows; every reserve row requires its exact journal
  (`fn_spin_reserve_row_requires_exact_journal`).
- Do not remove the tier lockout to make the lobby honest again; the lockout is
  what keeps the pool from promising what it cannot pay.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics` (`res`
  CTE), view `v_spin_reserve_health`.
- Lockout: `fn_spin_draw_multiplier`, `fn_spin_draw_and_settle_atomic`
  (`tournaments.spin_locked_tiers`).
- Pool ownership and funding: `fn_spin_reserve_owner`,
  `fn_spin_reserve_wallet_fund`, `fn_spin_reserve_seed_from_union`.
