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

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | CRITICAL | **Club JAQK was routed as a standalone club.** It is a Midway Union member in `union_clubs` (since 2026-02-28) but `clubs.union_id` was NULL. The engine routes by `clubs.union_id`, so roughly half the platform's rake settled into JAQK's own `chip_treasury` (and was spent on horse funding) instead of the union Rake Treasury, and its BBJ fees fed a **separate club-level pool** instead of the shared union pool. Tournament buy-in rake routes the same way and would have bypassed the treasury too. | FIXED  |
| 2   | CRITICAL | **The weekly 90/10 close had never executed once.** `union_wallets.total_settlements` was 0 with 1,506,446.08 accumulated since 2026-04-29. The existing `fn_execute_union_rakeback` paid clubs out of the union **owner's personal player wallet** and never debited `rake_wallet`, so the treasury only ever grew.                                                                                                                                                                                             | FIXED  |
| 3   | MEDIUM   | `unions.settings.bbj_split` claimed 40/30/30 while the engine correctly applied 50/25/25. Metadata corrected to match the spec and the code.                                                                                                                                                                                                                                                                                                                                                                     | FIXED  |

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

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                            | Status                                                  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | CRITICAL | **`bbj_record_contribution` was not idempotent.** No unique gate on `(pool_id, hand_id)`, so an engine retry after a commit-then-timeout, or a `FeeReconciler` re-drive, banked the same hand's BBJ fee twice. (`FeeReconciler`'s own header claimed the RPC was "keyed per (table, hand)" — it was not.) **Proven live: 5 duplicate hands, 2.60 over-banked.**                    | FIXED                                                   |
| 2   | CRITICAL | **Cancel-refunds destroyed horse money.** The shared cleanup skipped horses ("horses paid nothing"), an assumption that became false the moment `fn_register_horse_for_tournament` began charging horses real chips. Every cancelled under-filled event burned their buy-ins and left un-reversed fee rows. The flat `buy_in + fee` refund also ignored rebuys/add-ons/re-entries. | FIXED                                                   |
| 3   | CRITICAL | **Player weekly rakeback was minted.** `fn_close_settlement_period` credited each player's 5–30% tier payout with **no offsetting debit anywhere** — every other movement in the platform is double-entry; this one inflated the economy weekly.                                                                                                                                   | FIXED                                                   |
| 4   | HIGH     | `atomic_distribute_rake` credited the `club_wallets` mirror `v_net := p_rake - p_bbj`, assuming `p_rake` was gross. It is not — `computeRakeAndBBJ` returns rake and BBJ fee as **separate additive** pot deductions. The mirror under-counted every BBJ hand. (No chips moved wrongly: nothing reads the mirror today. The counter was wrong.)                                    | FIXED + backfilled                                      |
| 5   | HIGH     | Tournament completion credited the union wallet and then wrote its `union_wallet_transactions` audit row as a **separate client call**, with `balance_after` taken from `chip_balance` instead of the `rake_wallet` it describes. A failed second write silently shrinks the weekly rakeback basis, which sums those rows.                                                         | FIXED (row now written inside `increment_union_wallet`) |
| 6   | MEDIUM   | `DynamicWallet` read `.backup_balance` off the un-unwrapped PostgREST array returned by `fn_bbj_pool_for_club` (the sibling line unwrapped it) — **Backup BBJ rendered 0.00** for every club.                                                                                                                                                                                      | FIXED                                                   |
| 7   | MEDIUM   | The weekly close attempted only the single most recent lapsed week, and the daemon watermark advanced even when the union step failed — any outage spanning a Monday lost that week's rakeback permanently.                                                                                                                                                                        | FIXED (`fn_union_weekly_rakeback_close_all`)            |
| 8   | MEDIUM   | No index served the weekly-close basis scan; retained 10% left `rake_wallet` with no debit row (ledger could never reconcile); `chip_balance` carried float dust.                                                                                                                                                                                                                  | FIXED                                                   |

**Upgrade:** `fn_union_treasury_selftest()` — a conservation sentinel the engine
runs **every settler cycle**, checking non-negative wallets, the
`rake_wallet <= chip_balance` sub-account invariant, rake-ledger reconciliation,
BBJ `(pool, hand)` uniqueness, retired pools holding zero, and no fully-lapsed
unclosed week. Breaches raise **deduped** `financial_alerts` rows.

---

## Pass 3 — hardening, and one bug I introduced

| #   | Severity                                               | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Status                                        |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 9   | CRITICAL (self-inflicted, caught before it could fire) | **Ordering.** Pass 2 made player rakeback draw on `clubs.chip_treasury`, but the settler paid players in step 1 and ran the union's 90% payback in step 1.5 — i.e. it drew on the treasury _before_ the thing that funds it. Every player payout would have deferred a week at the first close. Union close now runs **first**.                                                                                                                                                                                                                                                   | FIXED                                         |
| 10  | CRITICAL (security)                                    | **`add_bbj_contribution` was live and granted to `authenticated`.** It accepts **caller-supplied** main/backup/promo portions, writes them straight into `bbj_pools`, writes **no** ledger row, has no idempotency, ignores the 100k pivot and touches the dead `pool_amount` column. Any logged-in user could inflate the promo bank, which the sweep moves to the union promo wallet and promo rain pays out — a money-minting vector. Both code callers are dead (`BBJService.recordContribution` has no callers; World Hub `LobbyManager.js` is referenced by no page/route). | RETIRED (all overloads raise; grants revoked) |
| 11  | MEDIUM (audit hole)                                    | `fn_sweep_bbj_promo` (single-club) wrote **no** `union_wallet_transactions` row when the destination was a union — only `fn_sweep_bbj_promo_all` did. Union-destination sweeps through that path moved money with no ledger entry anywhere. This is _how_ historical sweeps became unauditable.                                                                                                                                                                                                                                                                                   | FIXED (audit parity)                          |
| 12  | INFO (measured)                                        | `get_union_bbj_status` returned a hardcoded `{balance: 0, active: false}` to every authenticated caller — a lie that reads as "no jackpot".                                                                                                                                                                                                                                                                                                                                                                                                                                       | FIXED (returns real figures)                  |

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

| Ledger                        | Holds                                                                  | Credited by                                                                        | Drained by                                                         |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `union_wallets.rake_wallet`   | **Rake Treasury** — this week's rake, all clubs, cash + tournament     | `atomic_distribute_rake`, `record_tournament_buyin_rake`, `increment_union_wallet` | weekly close (90% out to clubs, 10% redesignated to general funds) |
| `union_wallets.chip_balance`  | Union Bank — general funds; the rake wallet is a **sub-account of it** | as above                                                                           | weekly close payouts                                               |
| `clubs.chip_treasury`         | Club operational bank                                                  | weekly 90% rakeback (`fn_credit_treasury`)                                         | player rakeback (`fn_debit_treasury`), horse funding, cashouts     |
| `bbj_pools.main/backup/promo` | Jackpot 50/25/25 (30/40/30 above 100k main)                            | `bbj_record_contribution` only                                                     | `bbj_atomic_payout_v2`, promo sweep                                |
| `union_wallets.promo_wallet`  | Swept 25% promo slice                                                  | `fn_sweep_bbj_promo{,_all}`                                                        | promo rain / distribution                                          |

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

---

## Pass 4 — the wallet panel itself (the surface Dan was looking at)

| #   | Severity                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 13  | CRITICAL (latent regression) | **Commit `714738896` deleted 102 lines from `DynamicWallet`**, removing the Rake Treasury row, the union rake/promo reads and the **union-first BBJ resolver**. Because both club-level BBJ pools were merged into the union pool and _retired_ earlier the same day, a union club resolving its jackpot by `club_id` now finds its own permanently-zero retired row — a **0.00 Bad Beat Jackpot on screen with 14k in the pool**. Production was still serving an older, correct bundle, so it never went live. | FIXED  |
| 14  | HIGH (wrong by permission)   | `union_wallets` is RLS-restricted to union owners/admins. A **club** owner inside a union read nothing, and the panel printed **"Union Bank 0.00 / Rake Treasury 0.00" as fact**. The panel now knows its permitted scope and renders "—" for what it may not see.                                                                                                                                                                                                                                               | FIXED  |
| 15  | HIGH (wrong source)          | The union variant's **"Clubs Wallet" read `clubs.chip_pool` of the one selected club** — the mint-and-distribute ledger, not a union figure at all, and 0.00 for a union whose clubs hold ~800k. Now sums member clubs' operational banks.                                                                                                                                                                                                                                                                       | FIXED  |
| 16  | MEDIUM (misread by design)   | **Rake Treasury is a sub-account of Union Bank**, yet both rendered as sibling rows that appear to sum. Union Bank now shows its unreserved remainder; the treasury row states what leaves it and when.                                                                                                                                                                                                                                                                                                          | FIXED  |
| 17  | MEDIUM                       | Repeated `CHANNEL_ERROR`s **stacked one reconnect timer per event**, each firing its own full refetch — a thundering herd exactly when the connection is already unhealthy.                                                                                                                                                                                                                                                                                                                                      | FIXED  |
| 18  | LOW                          | `aria-live="polite"` sat on a container whose numbers tick every animation frame — a screen reader announced ~60×/second during every count-up.                                                                                                                                                                                                                                                                                                                                                                  | FIXED  |
| 19  | LOW                          | Backup BBJ rendered for union scope only, so a standalone club holding a reserve never saw it; and it was unlabelled, reading as spendable money rather than a reserve that reseeds the main jackpot.                                                                                                                                                                                                                                                                                                            | FIXED  |

**The structural fix:** all of this now comes from **one** server function,
`fn_club_money_panel(club_id)`, which resolves the pool union-first exactly as
the engine banks it, returns the caller's permitted `scope`, and adds what the
money is _for_ (this club's 90% due at the next close, the projected split, the
close date). A client-side edit can no longer silently un-fix the rule — which
is precisely how finding #13 happened. It also replaces three reads plus a
serial second round trip with a single call.

Verified live with simulated identities: union owner → full figures; plain
member → `scope: 'member'` with **zero** leakage of union bank / rake treasury /
clubs wallet / club rake; unauthenticated → `authorized: false`.

**Deploy note worth keeping:** the sync commit labelled `cf40c23d0` did not
contain that SHA's code — its assets lacked `fn_club_money_panel` entirely,
i.e. it was built from a stale working tree and tagged with current HEAD.
Always verify a built asset contains the change before calling it shipped:
`grep -l <new symbol> dist/assets/*.js`.

---

## Pass 5 — the two biggest money bugs of the whole engagement

Both found by measuring rather than reading, both pre-existing, both silent.

### 20. CRITICAL — rake was credited to the Union Bank _as well as_ the Rake Treasury

Dan, from the live panel: _"RAKE IS STILL GOING TO THE UNION BANK INSTEAD OF THE
RAKE TREASURY."_ Correct. Every credit incremented **both** `chip_balance` and
`rake_wallet`, because the treasury was modelled as a sub-account _inside_ the
bank — so the bank climbed with every raked hand.

The rule is that rake is held by the union **only** under the Rake Treasury,
for the week, then 90% back to clubs with the union keeping 10%. That makes them
separate pots. `atomic_distribute_rake`, `increment_union_wallet` and
`record_tournament_buyin_rake` now credit the treasury only; the weekly close
pays clubs **out of** the treasury and moves just the retained share into the
bank; the solvency guard follows the chips.

One-time correction in the same transaction as the function swap (so a
concurrent credit is counted either the old way before the row lock or the new
way after commit): `chip_balance -= rake_wallet`. Union Bank
**630,802.14 → 120,895.24**; the 509,906.90 removed was never the union's to
spend. Verified live: over two minutes Union Bank moved **0.00** while the
treasury took **+342.03**.

The sentinel's `rake_wallet <= chip_balance` invariant described the old nested
model and would now fire on every healthy union — replaced with non-negativity.

### 21. CRITICAL — rakeback periods were computed from ~1% of each week

The settler derived `rake_generated` by FETCHING a club's week of `rake_records`
with `.limit(50000)` and summing in JavaScript. **PostgREST caps a response at
1000 rows**, so it saw ~1000 records of a week holding **81,000–180,000**.

Measured on live pending periods:

| user      | stored | actual | recorded |
| --------- | ------ | ------ | -------- |
| 1c1c12c2… | 23.17  | 377.01 | 6%       |
| 00bc0957… | 24.54  | 387.38 | 6%       |

and entire club-weeks (122–310 player rows each) recorded **0.00**.

It is worse than a proportional shortfall, because `rake_generated` also selects
the rakeback **tier** (5/10/15/20/30% at 100/500/2000/10000) — understated rake
drops a player into a lower band, compounding the loss.

The cap cannot be lifted from the client, so the computation moved into the
database (`fn_rakeback_recompute_periods`), reproducing `equalShareCents`
exactly: same integer-cents base, same remainder-to-the-first-keys rule (jsonb
sorts equal-length UUID keys lexicographically — the order the engine sees),
same tier ladder, paid weeks left immutable.

**Backfilled every pending period.** Money owed to players went from
effectively nothing to **119,039.91** across 1,927 rows (907,001.40 of rake
now correctly attributed), with **zero** rows still reading 0.00.

Funding after the correction: SHARK CLUB is covered (801,675 treasury against
50,392 owed). Club JAQK owes 68,646 against a 12.58 treasury, so its payouts
will **defer with a financial alert** — which is the designed behaviour from
finding #3 — and clear when the Monday close pays JAQK its 90%.

> Note the interaction: #20 and #21 are why the union looked rich and the
> players looked owed nothing. The bank was inflated by money held in trust,
> and the players' ledger was computed from a truncated sample.
