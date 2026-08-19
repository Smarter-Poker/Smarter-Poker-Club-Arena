# Rake, BBJ & Union Treasury — full audit, fixes and hardening (2026-08-19)

**Scope:** the entire money path — pot deduction → rake/BBJ ledgers → club/union
wallets → weekly union rakeback → player rakeback → BBJ pools/payouts — in code
AND against live production (`kuklfnapbkmacvwxktbh`).

**Dan's spec, restated (this is the contract everything below is measured against):**

- ALL rake is held by the **union** wallet under the **Rake Treasury**, from every
  live cash-game hand and every tournament/SNG registration.
- Those chips are held for the week. At the weekly close **90% goes back to the
  member clubs**, the **union keeps 10%**.
- BBJ fees are taken out and held by the union wallets: **50% main BBJ,
  25% backup BBJ, 25% promo wallet** (30/40/30 once main passes 100k).
- It must be correct and accurate **at all times**.

---

## Pass 1 — why the numbers on the dashboard were wrong

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | **Club JAQK was routed as a standalone club.** It is a Midway Union member in `union_clubs` (since 2026-02-28) but `clubs.union_id` was NULL. The engine routes by `clubs.union_id`, so roughly half the platform's rake settled into JAQK's own `chip_treasury` (and was spent on horse funding) instead of the union Rake Treasury, and its BBJ fees fed a **separate club-level pool** instead of the shared union pool. Tournament buy-in rake routes the same way and would have bypassed the treasury too. | FIXED |
| 2 | CRITICAL | **The weekly 90/10 close had never executed once.** `union_wallets.total_settlements` was 0 with 1,506,446.08 accumulated since 2026-04-29. The existing `fn_execute_union_rakeback` paid clubs out of the union **owner's personal player wallet** and never debited `rake_wallet`, so the treasury only ever grew. | FIXED |
| 3 | MEDIUM | `unions.settings.bbj_split` claimed 40/30/30 while the engine correctly applied 50/25/25. Metadata corrected to match the spec and the code. | FIXED |

**Actions:** `clubs.union_id` set for JAQK; its BBJ pool (main 4,722.72 / backup
2,691.02 / promo 0.59) merged into the union pool and retired;
`fn_union_weekly_rakeback_close` written (treasury-funded, idempotent per
`(union, period)` via `union_rakeback_log`, basis = `union_wallet_transactions`
rake credits, rate = `union_clubs.club_commission_rate`); wired into the engine's
weekly close. **Catch-up close executed** for 2026-04-01..2026-08-17: SHARK CLUB
paid **980,957.04**, union retained **109,528.17**.

> JAQK receives no back-pay: its historical rake never entered the union wallet —
> it had already kept 100% of it via its own treasury under the standalone path.

---

## Pass 2 — line-by-line, every function in the path

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | **`bbj_record_contribution` was not idempotent.** No unique gate on `(pool_id, hand_id)`, so an engine retry after a commit-then-timeout, or a `FeeReconciler` re-drive, banked the same hand's BBJ fee twice. (`FeeReconciler`'s own header claimed the RPC was "keyed per (table, hand)" — it was not.) **Proven live: 5 duplicate hands, 2.60 over-banked.** | FIXED |
| 2 | CRITICAL | **Cancel-refunds destroyed horse money.** The shared cleanup skipped horses ("horses paid nothing"), an assumption that became false the moment `fn_register_horse_for_tournament` began charging horses real chips. Every cancelled under-filled event burned their buy-ins and left un-reversed fee rows. The flat `buy_in + fee` refund also ignored rebuys/add-ons/re-entries. | FIXED |
| 3 | CRITICAL | **Player weekly rakeback was minted.** `fn_close_settlement_period` credited each player's 5–30% tier payout with **no offsetting debit anywhere** — every other movement in the platform is double-entry; this one inflated the economy weekly. | FIXED |
| 4 | HIGH | `atomic_distribute_rake` credited the `club_wallets` mirror `v_net := p_rake - p_bbj`, assuming `p_rake` was gross. It is not — `computeRakeAndBBJ` returns rake and BBJ fee as **separate additive** pot deductions. The mirror under-counted every BBJ hand. (No chips moved wrongly: nothing reads the mirror today. The counter was wrong.) | FIXED + backfilled |
| 5 | HIGH | Tournament completion credited the union wallet and then wrote its `union_wallet_transactions` audit row as a **separate client call**, with `balance_after` taken from `chip_balance` instead of the `rake_wallet` it describes. A failed second write silently shrinks the weekly rakeback basis, which sums those rows. | FIXED (row now written inside `increment_union_wallet`) |
| 6 | MEDIUM | `DynamicWallet` read `.backup_balance` off the un-unwrapped PostgREST array returned by `fn_bbj_pool_for_club` (the sibling line unwrapped it) — **Backup BBJ rendered 0.00** for every club. | FIXED |
| 7 | MEDIUM | The weekly close attempted only the single most recent lapsed week, and the daemon watermark advanced even when the union step failed — any outage spanning a Monday lost that week's rakeback permanently. | FIXED (`fn_union_weekly_rakeback_close_all`) |
| 8 | MEDIUM | No index served the weekly-close basis scan; retained 10% left `rake_wallet` with no debit row (ledger could never reconcile); `chip_balance` carried float dust. | FIXED |

**Upgrade:** `fn_union_treasury_selftest()` — a conservation sentinel the engine
runs **every settler cycle**, checking non-negative wallets, the
`rake_wallet <= chip_balance` sub-account invariant, rake-ledger reconciliation,
BBJ `(pool, hand)` uniqueness, retired pools holding zero, and no fully-lapsed
unclosed week. Breaches raise **deduped** `financial_alerts` rows.

---

## Pass 3 — hardening, and one bug I introduced

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 9 | CRITICAL (self-inflicted, caught before it could fire) | **Ordering.** Pass 2 made player rakeback draw on `clubs.chip_treasury`, but the settler paid players in step 1 and ran the union's 90% payback in step 1.5 — i.e. it drew on the treasury *before* the thing that funds it. Every player payout would have deferred a week at the first close. Union close now runs **first**. | FIXED |
| 10 | CRITICAL (security) | **`add_bbj_contribution` was live and granted to `authenticated`.** It accepts **caller-supplied** main/backup/promo portions, writes them straight into `bbj_pools`, writes **no** ledger row, has no idempotency, ignores the 100k pivot and touches the dead `pool_amount` column. Any logged-in user could inflate the promo bank, which the sweep moves to the union promo wallet and promo rain pays out — a money-minting vector. Both code callers are dead (`BBJService.recordContribution` has no callers; World Hub `LobbyManager.js` is referenced by no page/route). | RETIRED (all overloads raise; grants revoked) |
| 11 | MEDIUM (audit hole) | `fn_sweep_bbj_promo` (single-club) wrote **no** `union_wallet_transactions` row when the destination was a union — only `fn_sweep_bbj_promo_all` did. Union-destination sweeps through that path moved money with no ledger entry anywhere. This is *how* historical sweeps became unauditable. | FIXED (audit parity) |
| 12 | INFO (measured) | `get_union_bbj_status` returned a hardcoded `{balance: 0, active: false}` to every authenticated caller — a lie that reads as "no jackpot". | FIXED (returns real figures) |

### The BBJ conservation gap — measured, explained, and now guarded

The identity

```
Σ contributions + union funding
  − jackpot payouts − promo swept (union + club) − promo paid from pool
  − current pool balances
```

evaluates to **59,510.86**. It was measured three times across ~90 minutes of
live traffic and came back **identical to the cent every time** while inflow,
outflow and balances all moved — i.e. **the current paths conserve exactly**, and
this is pre-existing history: manual promo sweeps performed before audit rows
existed (including the known one-time 47,607.05) plus earlier pool
consolidations. Verified there are **zero orphan pool rows** — every
`bbj_contributions.pool_id` resolves to a live pool.

Rather than fabricate a balancing entry, the delta is **recorded as data** in
`bbj_conservation_baseline`, and `fn_bbj_conservation_check()` (folded into the
sentinel) alerts only when the gap **moves off that baseline** — which is the
condition that actually indicates new money loss. Live drift: **0.00**.

---

## Where the money lives now (canonical)

| Ledger | Holds | Credited by | Drained by |
|--------|-------|-------------|------------|
| `union_wallets.rake_wallet` | **Rake Treasury** — this week's rake, all clubs, cash + tournament | `atomic_distribute_rake`, `record_tournament_buyin_rake`, `increment_union_wallet` | weekly close (90% out to clubs, 10% redesignated to general funds) |
| `union_wallets.chip_balance` | Union Bank — general funds; the rake wallet is a **sub-account of it** | as above | weekly close payouts |
| `clubs.chip_treasury` | Club operational bank | weekly 90% rakeback (`fn_credit_treasury`) | player rakeback (`fn_debit_treasury`), horse funding, cashouts |
| `bbj_pools.main/backup/promo` | Jackpot 50/25/25 (30/40/30 above 100k main) | `bbj_record_contribution` only | `bbj_atomic_payout_v2`, promo sweep |
| `union_wallets.promo_wallet` | Swept 25% promo slice | `fn_sweep_bbj_promo{,_all}` | promo rain / distribution |

**Cadence:** the engine's `RakebackSettlerService` runs every 30 minutes and, in
order: (1) union weekly 90/10 close for every unclosed lapsed ISO week,
(2) weekly financial close incl. player rakeback out of club treasuries,
(3) tournament sentinel, (4) union treasury sentinel. Steps 1 and 4 run **every
cycle** (idempotent, no-op mid-week) so a failure retries in 30 minutes rather
than 7 days.

## Verification performed

- Every money RPC dumped from `pg_proc` and diffed against its callers.
- BBJ idempotency probed live: double-call created one row, moved the pool once,
  second call a no-op; probe reversed.
- Catch-up close executed and reconciled; `chip_transactions` treasury credit and
  `union_wallet_transactions` debit rows confirmed.
- Post-deploy: JAQK rake credits confirmed flowing into the union treasury;
  tournament rake audit rows confirmed carrying correct `rake_wallet` balances.
- `fn_union_treasury_selftest()` → `healthy: true`, zero breaches, zero open
  alerts; `fn_bbj_conservation_check()` → drift 0.00 under live traffic.
- Engine restart observed in `hand_history` after each deploy.

## Deliverables

- Migrations (applied via MCP, mirrored in `supabase/migrations/`):
  `20260819_union_membership_jaqk_rejoin_and_bbj_pool_merge`,
  `20260819_fn_union_weekly_rakeback_close`, `20260819b`..`20260819h`.
- `fn_union_money_report()` — one call returning the whole money picture
  (wallets, week-to-date rake, projected 90/10 close per club, BBJ state, recent
  closes, open alerts, live selftest). Powers the union dashboard and Dan's
  live money artifact.
- Weekly scheduled verification (`union-money-weekly-check`, Mondays) that the
  automated close fired and every invariant is clean.

## Open / deliberately not changed

- The 30/40/30 pivot above 100k main BBJ is Bible V8 design, not a bug.
- Promo bank still disburses only via the manual admin "rain" RPC — a product
  decision for Dan, not a correctness issue.
- The historical 59,510.86 BBJ delta is documented and guarded, not "corrected".
  Correcting it would mean inventing chips; the money was moved by real
  historical operations whose audit rows never existed.
