# Historical Drift Report (as measured 2026-08-31, read-only)

All figures from production reads on 2026-08-31 before the hardening migrations. No historical
ledger evidence was rewritten or deleted; corrections remain linked compensating entries.

## Chip supply at audit time (2026-08-31 ~14:20 UTC)

| Pool | Amount |
|------|--------|
| Member wallets (`club_members.chip_balance`) | 164,771,645.57 |
| On the felt (cash `table_seats.stack`) | 1,635,145.90 |
| Club treasuries (`clubs.chip_treasury`) | 2,428,399.18 |
| Legacy club pools (`clubs.chip_pool`) | 12,459.07 |
| Club wallets (rake accumulator, non-circulating) | 4,306,490.19 |
| Union wallets (all six sub-wallets) | 1,959,145.01 |
| Agent wallets (agent + promo) | 6,726,000.00 |
| BBJ pools (main + backup + promo) | 120,578.90 |
| Spin reserve pools | 61,882.56 |
| Member promo balances | 0.00 |
| **Frozen** `public.wallets` (stranded 2026-08-21, nothing reads it) | 732,591,994.33 |

Hourly `ca_supply_snapshots` now tracks these totals against ledgered issuance/retirement.

## Drift on the books (ledger_reconcile_log, runs 2026-08-28 → 2026-08-31)

| Class | Rows | Abs. drift | Status |
|-------|------|-----------:|--------|
| club_treasury (critical) | 8 | 48,172,984.00 | Ledger-vs-stored divergence measured from the pre-baseline era. Root cause: treasury movements were largely unledgered before the 2026-08-31 baselines (`ca_treasury_baseline` "measured from the line"). The 08-31 run reconciles clean against the new baseline. Largest: club `a0000000-…-01` ledger −24.3M vs stored 1.05M; `a41434bb…` −3.78M vs 1.38M; Midway Union club row −8,114.43 vs 0. Historical, explained, not a live leak. |
| seat_stack_exit (critical) | 1,033 | 431,906.31 | Seat exits with no matched wallet credit, 08-29→08-30 window. The exit trigger has since been corrected (settled-row deletes and tournament tables excluded) and the locked cash-out RPC landed 08-27; **fn_unaccounted_seat_exits returns ZERO rows for the last 2 days** — the leak class is closed; historical rows remain as evidence. |
| negative_balance (critical) | 2 | 12,007.20 | Midway Union treasury −1,202.80 (overlay-funded, by design, alarmed) + one agent pool; both clear by 08-31. The 5-minute detector now raises incidents on any recurrence. |
| bomb_award_ledger_gap | 18 | 1,502.50 | Reporting-layer gaps; hourly repair job drains them. |
| frozen_wallets_pool | — | 0.00 | No movement since freeze. Now checked every 5 minutes. |
| insurance_bank | — | 0.00 | Reconciles exactly. |

## The 'adjustment' plug (30 days to 2026-08-31)

| category | rows | amount |
|----------|-----:|-------:|
| adjustment | 125,586 | 65,507,543.29 |
| tournament_prize | 2,368 | 215,434.06 |
| cashout | 1,036 | 432,100.90 |
| bounty | 33 | 383.00 |
| refund | 8 | 205.00 |

97% of rows / 99% of volume were category-anonymous. Not lost chips — unattributable bookkeeping.
Now being drained by the category GUC plumbing; the daily suspense-flow incident measures what
remains (first reading 2026-08-31: 3,449.20 chips of pre-categorization flow).

## Incidents caught live on day one (both resolved inside target)

1. **Tournament winner credit failure** (40 chips, spin `88349dbe…`): the 3 credit retries fell
   inside the 14:33–14:35 UTC ledger-hardening DDL lock window; the standing payout reconciler
   repaired it automatically ("Tournament payout reconciliation place 1"). Root-caused, verified
   in `wallet_transactions`, resolved.
2. **Rake/BBJ invariant audit** (8 violations, ~9 chips): transient unbanked fees; all 4 flagged
   hands verified re-driven (8/8 distribution legs present). Resolved.

## Known unresolved historical items (tracked, not hidden)

- The frozen `public.wallets` 732.59M — disposition (formal retirement entries against
  `chip_retirement` at the Midway epoch 3 reset) is proposed in doc 05.
- The tournament play-chip ~261-chip (0.012%) fractional-split drift on multi-table events —
  reported every conservation cycle, un-root-caused; open engine follow-up.
- `clubs.chip_pool` (12,459.07) — legacy parallel treasury; consolidation follow-up.
- Pre-baseline treasury history remains unexplained in detail by design: the baselines draw the
  line, epoch 1 rows carry the evidence, and epoch 2+ reconciles exactly.

## Round-2 addendum (2026-08-31 afternoon)

Two live leaks were caught and closed the same day by the new machinery: (1) 12 tournament
winner-prize credits failed during the hardening DDL lock windows (14:35/14:59 UTC) — all
verified repaid by the standing payout reconciler, zero failures since 15:00; (2) 10 BBJ drops
(5.70 chips) collected but never banked to the Midway pool between 14:10–15:07 — a pre-existing
~2% engine banking failure made visible by the hourly audit, all 10 banked by
`fn_bbj_repair_unbanked`, now self-healing on a 15-minute cron. The supply monitor's first
20.6K "unexplained" reading was in-flight tournament liability (now counted).
