# CHIP ACCOUNTING STANDARD - how buy-ins and cash-outs are supposed to work

**Status: BINDING from 2026-09-02. Author: Claude (Cowork), written from production evidence pulled the same day.**
**Scope: every chip movement in Club Arena - cash games, MTTs, SNGs, Spins, Heads-Up, satellites, bounties (PKO / mystery), rake, BBJ, promos, guarantees, freerolls.**

This document does three things, in order:

1. States the **industry standard** for how a poker room accounts for player money (sourced from GLI-19 v3.0, NJ DGE 13:69O, UKGC LCCP 4.1/4.2, PA PGCB 811a, MGA, and published operator policy).
2. Shows **exactly what we built**, path by path, with production numbers, and names each root cause of drift.
3. Sets the **standard we are moving to** - the chip lifecycle for every game type, where chips are held at each moment, the hard rules, the layers of protection - and the fix list that gets us there.

Everything in section 2 was measured on production between 16:00 and 18:30 UTC on 2026-09-02. Nothing is inferred from the repo alone; the repo mirror of several money functions is stale (`atomic_deduct_wallet_and_log`, `process_tournament_rebuy`, `fn_register_for_tournament`) and was cross-checked against `pg_proc`.

---

## 0. The one-paragraph answer

Money drifts on this platform for one architectural reason and four operational ones. **Architectural: a buy-in is destroyed at the wallet and re-minted at payout.** There is no account that holds the chips in between - `tournaments.prize_pool`, `bounty_pool` and `total_rake` are counters, not balances - so nothing can _refuse_ a payout that exceeds what was collected, and nothing can _refuse_ a prize pool that was never funded. **Operational: (1) eleven independent code paths can pay the same tournament place, each with its own idempotency key and its own evidence table, so they pay each other's obligations twice; (2) guarantees and freerolls raise the prize pool without a bank debit; (3) the rake specification lives in four places that disagree; (4) ~900 open financial alerts with no owner, so agents "fix" money with ad-hoc migrations that credit wallets outside the payout path - which is how today's double payments happened.** Cash-game hand settlement (pot = rake + BBJ + awards) is already exact over 11,975 hands; the cash-side defects that remain are narrower and listed in 2.3.

The fix is not another detector. It is: **an escrow balance per tournament that chips physically move into at buy-in and out of at payout; one obligations table with a generic non-refund settlement authority plus exact funding-provenance authorities for refunds and ticket returns; prize pools that cannot exceed what is funded; one rake spec read by both the engine and the DB; and a trial balance that names the account that drifted, every hour.**

---

## 1. Industry standard (what "supposed to be done" means)

### 1.1 Principles, with sources

| #   | Principle                                                                                                                                                                                                                                                    | Source                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| S1  | Customer funds are segregated from operator funds. Chips at a table ("funds on game") and pending withdrawals are still customer liabilities. Reserve = cashable balances + funds on game + pending withdrawals.                                             | NJ 13:69O-1.3(k); PA 811a.5; UKGC LC 4.1.1               |
| S2  | Progressive jackpots (BBJ) are reserved at 100% in a separate liability account.                                                                                                                                                                             | Nevada Reg 5A.125; GLI-19 §2.8.10                        |
| S3  | Double entry: every movement debits one account and credits another; entries net to zero; balances are derived from the journal and stored balances are a cache.                                                                                             | GLI-19 §2.8.6; common fintech ledger practice            |
| S4  | Journals are append-only; corrections are reversal + re-post, never UPDATE.                                                                                                                                                                                  | GLI-19 §2.5.7                                            |
| S5  | Every posting carries an idempotency key enforced by a DB unique constraint; restart/failover neither loses nor duplicates a transaction.                                                                                                                    | GLI-19 §B.3.5                                            |
| S6  | Manual adjustments require authorisation distinct from the initiator, a reason, and a daily review report; adjustments over a threshold are pre-authorised.                                                                                                  | NJ 13:69O-1.3(i), 1.9(k); GLI-19 §A.3.6(f)               |
| S7  | Player accounts cannot go negative; player-to-player transfers outside a game are impossible.                                                                                                                                                                | GLI-19 §A.3.6(d), §2.5.6(f)                              |
| S8  | Cash buy-in: wallet → table credit meter; exiting returns the stack automatically at a hand boundary; an interrupted hand is held and resolved before re-entry.                                                                                              | GLI-19 §4.3.5, §4.16.2                                   |
| S9  | Rake is taken from the pot before award, is a percentage with a cap that varies by players dealt, no-flop-no-drop, rounded to the chip unit, never over cap, attributed weighted-contributed. Changing a rake parameter is a logged significant event.       | GLI-19 §4.4.1(s), §2.8.7; PokerStars/GG published policy |
| S10 | BBJ drop is a fixed amount per qualifying hand (flop seen, min players dealt); contributions are never lost, payoffs never truncated; reset from reserve in the same transaction as the payout; reconciled monthly with variance > threshold as an incident. | GLI-19 §4.13.5–6; NJ 13:69O-1.10                         |
| S11 | Tournament buy-in splits into prize pool (liability) + fee (revenue) at registration; re-entries, rebuys, add-ons post to the same pool by the same rule; the fee is the only house take.                                                                    | GLI-19 §A.5.4, §2.8.4                                    |
| S12 | Overlay is house money paid INTO the pool before it is advertised as the pool, reported separately. A guarantee that the bank cannot fund is not a guarantee.                                                                                                | NJ 13:69O-1.9(d)(2)(x); PokerNews                        |
| S13 | Cancellation before play refunds buy-in AND fee in the original instrument; mid-event cancellation follows a published formula.                                                                                                                              | Ignition policy; PokerStars Live rules                   |
| S14 | PKO: half the bounty to the eliminator's wallet, half to their own head; total bounty liability is conserved. Mystery bounty chests are a sealed inventory whose sum equals the bounty pool.                                                                 | PokerStars                                               |
| S15 | A satellite pays a seat (ticket), not cash; unregistering yields a ticket, not withdrawable money; the target's pool is funded by the satellite's pool, not by fiat.                                                                                         | PokerStars satellite rules                               |
| S16 | Spin & Go multiplier drawn from a published table with published frequencies; E[multiplier] = seats × (1 − rake); high tiers funded from a reserve that the low tiers fill.                                                                                  | PokerStars published tables                              |
| S17 | Daily trial balance: total liabilities + house accounts = total value issued; a break produces a Variance Report with a documented reason; a persistent break disables the affected game.                                                                    | NJ 13:69O-1.9(d),(f); GLI-19 §B.2.1                      |
| S18 | Prize pools are split to exact cents; the remainder goes to a deterministic place; the prize-pool ledger reaches exactly zero when the last payout is made.                                                                                                  | common practice                                          |

### 1.2 The conservation identity (the thing every check reduces to)

```
ISSUED = wallets + promo + felt (cash stacks) + tournament escrow (prize + bounty + fee, per live event)
       + BBJ pools + spin reserve + club treasuries + union banks + agent wallets + pending withdrawals
```

ISSUED changes only through the Mint (issuance) and retirement (burn). Every other movement is a transfer between two of those accounts and must appear as one ledger row with both sides named. If ISSUED moves and the ledger shows no mint/burn, an account was written outside the ledger, and the trial balance must say _which one_.

---

## 2. What we built - path by path, with production numbers

### 2.1 The accounts that exist today

| Account (industry name)      | Our column                                             | Is it a real balance?                               | Ledgered?                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player wallet                | `club_members.chip_balance`                            | Yes (DECIMAL 15,2)                                  | Yes - trigger `fn_club_members_ledger_writer`; balance Δ matched ledger to the cent over 16h (+41,899.36 = +41,899.36)                                                 |
| Funds on game (cash)         | `table_seats.stack`                                    | Yes                                                 | Deliberately not per-hand; crossings only. 16h: felt Δ −17,231 vs ledger −4,210 (the gap is rake/BBJ leaving the felt, journaled from `table_stack` on the other side) |
| **Tournament prize escrow**  | `tournaments.prize_pool`                               | **NO - a counter**                                  | No account, no CHECK, no counterparty                                                                                                                                  |
| **Tournament bounty escrow** | `tournaments.bounty_pool − bounty_pool_paid`           | **NO - counters**                                   | No                                                                                                                                                                     |
| **Tournament fee escrow**    | `tournaments.total_rake`                               | **NO - counter**, settled to treasury at completion | Settlement leg only                                                                                                                                                    |
| BBJ pools                    | `bbj_pools.main/backup/promo_balance`                  | Yes                                                 | Yes (autoledger); Δ 2,418.89 vs ledger 2,418.28                                                                                                                        |
| Spin reserve                 | `spin_bonus_pools.balance`                             | Yes                                                 | Yes; exact                                                                                                                                                             |
| Club treasury                | `clubs.chip_treasury`                                  | Yes                                                 | Yes; exact (−27,558.68 both sides)                                                                                                                                     |
| Union bank                   | `union_wallets.*`                                      | Yes                                                 | 42.09 unledgered in 16h (backpay function uses `ledger_autoskip`)                                                                                                      |
| Rake accumulator             | `club_wallets.chip_balance`                            | Yes (not circulating)                               | Exact                                                                                                                                                                  |
| Satellite ticket             | `tournament_players.is_satellite_qualifier`            | **NO** - a flag, no value held                      | No                                                                                                                                                                     |
| Pending withdrawal escrow    | `chip_escrow`                                          | Yes (cashier only)                                  | Reconciled                                                                                                                                                             |
| `chip_escrow_holds`          | exists since 2026-04-28, FK to the dead `wallets` pool | **zero callers**                                    | -                                                                                                                                                                      |
| Dead pool                    | `public.wallets`                                       | frozen, 732.59M stranded                            | detector only                                                                                                                                                          |

**Consequence of the three NO rows:** between registration and payout the buy-in chips exist nowhere. `fn_ca_supply_snapshot` papers over this by adding `prize_pool + bounty_pool − bounty_pool_paid + total_rake` for non-completed events into the supply total, so the identity holds _only if those counters are honest_. When a counter is raised without money (a guarantee, a freeroll, a satellite seat), supply is minted silently at payout time.

### 2.2 Measured drift, 2026-09-02

**Supply.** `ca_supply_snapshots`, 00:05 → 16:05 UTC: total +8,525.42 with mint 0 and burn 0. Same-sign positive in 13 of 17 hours. ≈ +500 chips/hour of chips appearing from nowhere.

**Tournaments, all COMPLETED in the trailing 36h (wallet_transactions evidence per event):**

| Variant            | Events | Money in   | Paid to players | Rake settled | Net (in − out − rake)                 | Over-paid events |
| ------------------ | ------ | ---------- | --------------- | ------------ | ------------------------------------- | ---------------- |
| sng                | 4,337  | 214,719.00 | 203,983.05      | 10,735.95    | **0.00**                              | 0                |
| satellite          | 4      | 1,070.00   | 963.00          | 107.00       | **0.00**                              | 0                |
| spin               | 4,664  | 303,760.00 | 284,040.00      | 24,297.60    | −4,577.60 (reserve variance; see 2.5) | n/a              |
| freezeout          | 51     | 11,067.00  | 11,760.10       | 903.90       | **−1,597.00**                         | 20               |
| bounty             | 16     | 7,255.00   | 7,823.00        | 725.50       | **−1,293.50**                         | 11               |
| mystery_bounty     | 9      | 3,255.00   | 4,654.50        | 325.50       | **−1,725.00**                         | 8                |
| progressive_bounty | 6      | 3,180.00   | 3,576.80        | 318.00       | **−714.80**                           | 5                |

SNG is exactly conserved: one payout path, one key per place, no guarantees. The four MTT variants are overpaid by **5,330 chips in 36h across 82 events** - 24% of everything they collected. That is the supply leak.

**Where the MTT overpayment comes from (every event traced):**

1. **Unfunded guarantees.** "Afternoon Bounty": 23 × 10 = 230 in; rake 23, bounty 69, so the real prize pool is 138. Guarantee 200 → `prize_pool = 200`, **no row in `tournament_guarantee_overlays`, no bank debit.** Paid 200 + 69 + 23 = 292 on 230 in. The 62 missing chips were minted at payout. 20 of the 70 completed events with `prize_pool = guaranteed_prize` have no overlay row.
2. **Freerolls with a prize pool and no funder.** "$100 Freeroll • 6:00 PM": money in 0, prize_pool 100, paid 100. Six of these a day, 75–190 each. Nobody's account was debited.
3. **Double payment by independent repair arms.** "Union Grand Championship (NLH)", 68 entries × 50: rake 340, bounty 1,020, prize pool 2,040, guarantee 2,500. Structure paid 2,040 correctly. Then: 01:19 a migration (`back_fund_the_six_unfunded_guarantees`) credited the 460 shortfall to nine wallets via `wallet_transactions` but wrote no `tournament_payouts` rows; 03:54 `fn_tournament_payout_reconcile` read `tournament_payouts`, saw 2,040 paid against a 2,500 pool, and paid the same 460 again under `:reconcile` keys; 04:19 another migration back-filled `overlay_backpay` rows for the first payment. Paid 2,960 on a 2,500 pool. The same sequence hit "Union Mystery Bounty" (+700), "Evening Mystery Bounty" (+350), "Turbo Tuesday Opener" (+32). The migration's own header reads: _"I caused a double payment and this is the fix for the mechanism that let me."_
4. **Cent-level disagreement between payers.** `fn_tournament_payout_reconcile` reports `overpaid 0.01` (Sunday PLO High Roller, place 1: expected 1,290.32, paid 1,290.33) and `overpaid 2.03 / 2.72` (Early Bird Freeroll): the engine's `computePlacePrize` and the DB reconciler's ladder disagree when the field is trimmed or when the pool changed after a place was paid. 41 open criticals.
5. **Underpayment (the other direction).** `fn_payout_guarantee_check`: 65 open `earner_not_paid` criticals, mostly freerolls (place 4 owed 8.00, wallet received 0) - the pool was 0 at finish because nobody funded it, so the engine paid nothing, and the detector correctly says the player is owed.

**The eleven payers.** Engine place 2..N at bust (`prize:place:N`), engine place 1 at finish (`prize:place:1`), bubble protection, late-reg `prizeadj` (amount inside the key, so a re-run with a new amount is a _new_ key), final-table deal, recovery sweep (same `prize:place:N` - the one pair that dedupes), `fn_tournament_payout_reconcile` (`:reconcile`), `fn_pay_backed_payout_shortfalls`, `fn_backpay_spin_unpaid_winners` (`spin_backpay`), `fn_backpay_hu_winner_shortfalls` (`hu_shortfall`), `fn_ca_backpay_guarantee_shortfalls` → reconciler, and **agent migrations**. Two evidence tables: `wallet_transactions` (what moved) and `tournament_payouts` (what the reconciler believes). Any arm that writes one and not the other causes the next arm to pay again.

### 2.3 Cash games - buy-in, cash-out, rake, BBJ (measured healthy at the hand level)

- **Pot conservation:** 11,975 cash hands in 3h, `pot = rake + bbj + Σ awarded` on every one; net gap 0.00.
- **Rake banking:** 22,680 raked hands / 24h, 40,966.57 rake; 1 hand (6.10) without a distribution leg; re-driven by `FeeReconciler`.
- **BBJ banking:** contributions in `bbj_contributions` match `rake_records.bbj_contribution` within the window.
- **Seat exits:** 3,488 cash exits in 48h, all credited except **13 via "Supavisor" (a direct DB connection, 1,390.74 chips uncredited)** - a human or agent tool, not the engine.
- **Buy-in:** `atomic_table_buyin` is one transaction (debit + seat + `wallet_transactions` + `chip_ledger`), keyed. Correct.
- **Cash-out:** `atomic_seat_cashout_locked` is one transaction, keyed per seat occupancy. Correct.

Cash-side defects that remain (none are the drift, all are latent):

| #   | Defect                                                                                                                                                                                                                                                                                                                                                                                                            | Where                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| C1  | `atomic_table_cashout` and `atomic_table_withdraw` carry **no idempotency key**; a retry of a committed-but-unacknowledged call double-credits. `atomic_table_withdraw` passes `p_idempotency_key => NULL` explicitly.                                                                                                                                                                                            | `20260831144915_…`, `20260827063121_…`                   |
| C2  | `HydraService.ts:541-554` INSERTs `table_seats` with a stack from the browser with no wallet debit - a mint if reachable.                                                                                                                                                                                                                                                                                         | `src/services/HydraService.ts`                           |
| C3  | `syncStacks` writes `table_seats.stack` **absolutely** from engine memory while `atomic_table_rebuy` / `resolve_pending_addon` / `bbj_credit_one_recipient` / `fn_horse_fund_from_treasury` do `stack += n`. A credit that lands between `loadSeatedPlayers` and the next `syncStacks` is erased while the wallet stays debited. Mitigated for add-ons (`table_pending_addons`), not for the 5-second bust rebuy. | `tables.ts:189-282`, `ServerTableEngineSeating.ts:78-92` |
| C4  | The boot stale-seat sweep cashes out **horse seats only** (`GameServer.ts:2067-2092`). A human's stack stays on the felt through a restart; `TablePage.tsx:8200` claims the opposite. Horses-are-players law (CLAUDE.md 10.5) says the treatment must be identical either way. **Fork for Dan: sweep everyone, or sweep nobody.**                                                                                 |                                                          |
| C5  | `player_leave_table` sets no `app.ledger_category`, so cron-eviction cash-outs land in `chip_ledger` as `adjustment`. `fn_cashout_seats_for_closing_table` clears the GUC before the counterparty is declared.                                                                                                                                                                                                    | `20260826_retire_dead_leave_rpcs…`, `20260830212438_…`   |
| C6  | Four cash money RPCs have **no definition in the repo** (`fn_ca_settle_hand_stacks_absolute`, `resolve_pending_addon`, `fn_add_chips`, `credit_club_wallet_rake`). Production-only.                                                                                                                                                                                                                               |                                                          |
| C7  | Run-it-twice with side pots splits `state.pot` as one pot (documented limitation `RunItTwiceEngine.ts:476`).                                                                                                                                                                                                                                                                                                      |                                                          |

### 2.4 Rake and BBJ - the spec lives in four places

Measured on 2,044 flop-seen cash hands in 90 min against `ca_rake_schedule`: **0 hands over the schedule; 421 hands under (−359.89)**. Every "under" traces to a rule the DB schedule does not know about:

- Heads-up (2 dealt): 5% and half cap (2.50 on a 5.00 cap) - the engine's `HEADS_UP_RAKE_PERCENT = 5` rule. Correct by law, absent from `ca_rake_schedule`.
- 3 dealt: cap 3.35 not 5.00 - the engine's `playerCountCaps`. Absent from `ca_rake_schedule`.
- 3.00 BB tables: **no schedule row at all**; engine uses its own table.
- BBJ 0 on some 5-dealt flop hands: per-club BBJ disabled. Legitimate, but the DB check cannot tell.

So there is **no over-rake and no under-rake** relative to the engine's spec; there is a **spec split**: `tables.rake_percent = -1 / rake_cap_bb = -1` (sentinel), `ca_rake_schedule` (per-stake pct + cap + BBJ drop, no player-count dimension), `ca_rake_tier` (bands), engine constants (`playerCountCaps`, HU 5%, `noFlopNoDrop`, `minPlayersDealt`), and per-club BBJ enable. `fn_rake_law_check` and `fn_rake_bbj_audit` cannot reproduce the engine's number, so their findings are noise, and a change on one side is invisible to the other. That is how a rake _would_ drift; it is not drifting today.

### 2.5 Spins and SNGs

- SNG: exactly conserved (table in 2.2).
- Spin money: buy-ins fund `spin_bonus_pools` net of a flat 8%; the drawn multiplier is paid from that reserve. `SPIN_TIERS` E[multiplier] = 27,638,000 / 10,000,099 = **2.7638** vs implied 3 × 0.92 = **2.76** - the table over-pays by 0.13% of buy-in by construction (≈117 chips over the 36h window). The observed −4,577 reserve drain is 1.9σ of expected variance for 4,664 games and is not a defect; the invariant test `spinRakeInvariant` should be tightened to equality within 1e-4 and the 2x/3x frequencies re-balanced.
- **In-play chip conservation is broken in ~10% of spin/SNG games** (`fn_spin_chip_conservation_check`: 114 of 1,206 games minted 18,406 tournament chips in 6h; worst single game +1,000). Tournament chips are not money, but they decide the winner. Root cause is C3's tournament twin: `tournament_players.chips` is overwritten from engine memory (`Math.floor`, `tables.ts:338`) and rebuy/add-on credits race it.

### 2.6 Satellites, tickets, bounties

- `fn_award_satellite_seat` does `target.prize_pool += target.buy_in_amount` and `target.total_rake += target.buy_in_fee` with **no chips debited from anyone** and the satellite's own pool never debited. The target then owes prize money it never received; its rake is settled to the treasury from an unpaid fee; a qualifier who unregisters is refunded `split.charge` in real chips they never paid; a cancelled target refunds the qualifier nothing. Satellite money in = seats out was 0.00 in the window only because no target was cancelled or unregistered.
- Satellite guarantee overlay is `console.log`'d and funded by nobody (`TournamentManager.ts:761`); `awardCount` is not capped by pool affordability.
- `fn_collect_bounty`, `fn_finalize_bounty_pool`, `fn_leave_seat_and_refund` use `credit_player_wallet` (no ledger row) + an **unconditional** `log_wallet_transaction` - a replay writes a phantom credit row that `fn_finalize_bounty_pool` then subtracts from the residual it computes.
- `fn_finalize_bounty_pool` key `tourney:<t>:ownbounty:<winner>` carries no amount; a second run with a larger residual pays nothing.
- Rebuy/re-entry/add-on: `process_tournament_rebuy` rounds to whole chips, carves the fee out of the cost (initial buy-in adds it on top), defaults the fee ratio to 10% when `buy_in_fee = 0` (the entry split removed that default on 2026-08-23), charges add-ons zero rake, and writes no `chip_transactions` row. Re-entries do **not** reach the pool by the same rule as entries (violates S11).

### 2.7 Controls and the alert board

- Detectors: 20+ (`reconcile_ledger_nightly` ten checks, `fn_ca_quick_reconcile`, `fn_ca_supply_snapshot`, `fn_rake_law_check`, `fn_cash_pot_conservation_check`, `fn_tournament_money_conservation`, `fn_payout_guarantee_check`, `fn_rake_bbj_audit`, `fn_spin_chip_conservation_check`, `fn_ca_money_rpc_drift`, `fn_ca_ratchet_watch`, chain verify, …). They **report**. Only `fn_ca_auto_reconcile_tick` and named repair arms move money.
- **~900 open `financial_alerts` in 7 days**, 300+ critical. `fn_tournament_money_conservation` alone has 116 open warnings. `player_wallet` drift of 48.8M from a 2026-08-26 baseline run is still "open". Nothing distinguishes "money is missing now" from "a baseline was drawn last week".
- Ledger writes are **best-effort by design** (three-level swallow into `ca_ledger_write_failures`); `settlement_suspense` took +145,915.52 net in 16h - undeclared movements are parked there and the account that must be zero is not.
- `ca_money_rpc_registry` allow-lists writers, but a migration run by an agent, a `pg_cron` SQL body, or a Supavisor session is not a function and is not caught.
- No four-eyes on manual adjustments. Today's back-pay migrations were authored, approved and applied by the same agent in one sitting.

---

## 3. The standard we are moving to

### 3.1 Chart of accounts (real balances, every one ledgered)

| Account                                         | Backing                                                                        | Rule                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player_wallet`                                 | `club_members.chip_balance`                                                    | CHECK ≥ 0 (already)                                                                                                                                                                                                         |
| `table_stack`                                   | `table_seats.stack`                                                            | crossings ledgered; per-hand settlement absolute + verified                                                                                                                                                                 |
| **`tournament_escrow`** (NEW)                   | `tournament_escrow(tournament_id, prize_balance, bounty_balance, fee_balance)` | **CHECK ≥ 0 on each column.** Buy-in credits it; payout debits it; overlay credits it from a bank; settlement debits fee → treasury/union. A payout that would take it negative is REFUSED at the constraint, never minted. |
| `bbj_pool`                                      | `bbj_pools.*`                                                                  | as today                                                                                                                                                                                                                    |
| `spin_reserve`                                  | `spin_bonus_pools.balance`                                                     | as today; tier table EV pinned to equality                                                                                                                                                                                  |
| `club_treasury` / `union_bank` / `agent_wallet` | as today                                                                       | CHECK ≥ 0 already on most; add where missing                                                                                                                                                                                |
| **`ticket_liability`** (NEW)                    | `tournament_tickets` valued rows                                               | a satellite seat is a ticket worth `buy_in + fee`, funded by the satellite's escrow, redeemed into the target's escrow                                                                                                      |
| `issuance_reserve` / `chip_retirement`          | The Mint                                                                       | only way ISSUED changes                                                                                                                                                                                                     |
| `settlement_suspense`                           | -                                                                              | must be zero at every trial balance; anything parked there is an incident with a deadline                                                                                                                                   |

### 3.2 The chip lifecycle, per game type

**Cash game**

1. Sit: `atomic_table_buyin` - `player_wallet → table_stack`, keyed, one transaction. (as today)
2. Hand: engine settles in memory; `fn_ca_settle_hand_stacks_absolute` writes stacks, rake and BBJ **in one statement**, idempotent on (table, hand); DB asserts `Σ stack_before + 0 = Σ stack_after + rake + bbj` for that hand before committing. Rake row `table_stack → club_treasury|union_bank`; BBJ row `table_stack → bbj_pool`.
3. Rebuy / add-on: `table_stack += n` **only through `table_pending_addons`** so the absolute write cannot erase it (extend the pending mechanism to the bust rebuy).
4. Leave / evict / tab-close / table close / restart: `atomic_seat_cashout_locked` - `table_stack → player_wallet`, keyed per occupancy. **One function**, every path, humans and horses identically. `player_leave_table` and `fn_cashout_seats_for_closing_table` delegate to it.
5. Never: a `table_seats` INSERT with a stack from anywhere but `atomic_table_buyin`/`fn_take_seat_and_buy_in`; a `table_seats` DELETE; a stack UPDATE outside the settle RPC.

**MTT / SNG / Heads-Up**

1. Register: `fn_register_for_tournament` - `player_wallet → tournament_escrow.prize (+bounty) (+fee)` in one transaction, keyed `tourney:<t>:entry:<user>:<n>`. `prize_pool` etc. become **views over escrow**, not writable columns.
2. Re-entry / rebuy / add-on: same function family, same split rule (`fn_tournament_entry_split`), same escrow, keyed with the client token.
3. Guarantee / freeroll: at start (or at finish fallback) `fn_apply_prize_guarantee` - `union_bank|club_treasury → tournament_escrow.prize` for the overlay, **before** the pool is advertised as the guarantee. If the bank cannot fund it, the pool stays at contributions, `guarantee_unfunded` is raised critical, and the event pays what it holds. **A guarantee is money in escrow or it is not a guarantee.** Freerolls are guarantees with zero contributions - same rule.
4. Play: no money moves.
5. Payout: **`fn_settle_tournament_obligation(tournament_id, kind, place|user, amount)`** is the generic obligation authority for place, bounty and other non-refund payouts. It writes/updates `tournament_obligations`, refuses when `amount_paid >= amount_owed`, debits `tournament_escrow`, credits `player_wallet`, and writes `tournament_payouts` plus `wallet_transactions` atomically under one key. The generic eight-argument dispatcher always refuses `kind='refund'` with `exact_refund_authority_required`; a refund can credit a wallet only through `fn_settle_tournament_refund_exact`, which consumes one immutable `tournament_refund_entitlements` row and returns the exact prize/bounty/fee split to its recorded source wallet. A satellite-funded seat or spent entry ticket returns only through `fn_ca_return_satellite_entitlement_as_ticket` and never credits wallet chips.
6. Bounties: `fn_collect_bounty` → `tournament_escrow.bounty → player_wallet` (half) and `→ tournament_players.current_bounty` (half) via the obligation function; mystery chests are inventory rows whose sum equals `bounty_balance`.
7. Completion: `fn_settle_tournament_rake` - `tournament_escrow.fee → club_treasury|union_bank`; then **assert `prize_balance = bounty_balance = fee_balance = 0`** (S18). Residual ≠ 0 is an incident, not a silent mint or burn.
8. Cancellation: `atomic_cancel_tournament` consumes each immutable refund entitlement once. A `wallet_charge` moves its exact prize/bounty/fee rails from escrow back to the entitlement's recorded source wallet through `fn_settle_tournament_refund_exact`; `satellite_seat` and `tournament_ticket` entitlements become entry-only `tournament_tickets` through `fn_ca_return_satellite_entitlement_as_ticket`, with zero wallet credit. Then it asserts escrow = 0 and stores one replayable cancellation receipt.
9. Satellite: prizes are obligations of `kind='seat'`; `fn_award_satellite_seat` moves `satellite escrow.prize → target escrow.prize (+fee)` for exactly `buy_in + fee` per seat. No seat is created without that transfer. Unregistering from the target moves it back into a `tournament_tickets` row (ticket_liability), never to the wallet. Overlay on a satellite is funded like any guarantee.

**Spin**

1. Seat purchase → `tournament_escrow.prize` as any MTT.
2. Last seat: `fn_spin_book_entry` - `escrow.prize → spin_reserve` (net) and `escrow.fee → treasury` (8%); escrow.prize is then 0.
3. Draw: `fn_spin_draw_multiplier` reserves `buy_in × multiplier` **inside `spin_reserve`** (a `pending` sub-balance), so the reserve cannot be double-spent by concurrent draws.
4. Settle: `fn_spin_settle_game` - `spin_reserve → tournament_escrow.prize` for the drawn prize; payout then follows the MTT obligation path. Shortfall against a thin reserve is refused (the draw already excluded unaffordable tiers), never adjusted.
5. `SPIN_TIERS` must satisfy `|E[m] − seats × (1 − rake)| < 1e-4`, enforced by a law test.

**BBJ**

- Drop only on hands with a flop and ≥ `minPlayersDealt`, fixed `bbj_fee_bb × BB`, clamped to the pot with BBJ yielding first (as today). Row `table_stack → bbj_pool`, keyed on (pool, hand).
- Payout: `bbj_atomic_payout_v2` - `bbj_pool.main → player_wallet|table_stack` per recipient, split summing to the posted amount to the cent, reseed from backup in the same transaction (as today). Add: monthly `fn_bbj_reconcile()` - `main + backup + promo = seed + Σ contributions − Σ payouts − Σ restorations` per pool; variance > 1.00 is a critical incident.

**Promos / leaderboard / rakeback** - obligations of `kind='promo'|'leaderboard'|'rakeback'` funded from `club_treasury|union_bank` into a per-batch escrow before any credit; same settle function shape.

### 3.3 Hard rules (enforced in the database, not in prose)

| Rule                                                                                   | Enforcement                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 A tournament cannot pay more than its escrow holds.                                 | `CHECK (prize_balance >= 0)` etc. on `tournament_escrow`; settle function debits escrow in the same statement as the wallet credit.                                                                                                                                                                                                                             |
| R2 A place is paid once.                                                               | `UNIQUE (tournament_id, kind, place)` on `tournament_obligations` + `amount_paid <= amount_owed` CHECK.                                                                                                                                                                                                                                                         |
| R3 Every tournament credit uses its exact authority.                                   | Trigger on `wallet_transactions` / `club_members` admits generic non-refund obligations only through `fn_settle_tournament_obligation`; exact refunds require the authorization token created inside `fn_settle_tournament_refund_exact`. The generic dispatcher fails closed for `kind='refund'`, and noncash satellite/ticket returns cannot credit a wallet. |
| R4 A prize pool cannot exceed contributions + funded overlay + funded satellite seats. | `prize_pool` becomes a generated/view column over escrow; direct UPDATE refused.                                                                                                                                                                                                                                                                                |
| R5 Escrow is zero at completion and at cancellation.                                   | `fn_tournament_close_assert(t)` called by the completion and cancel paths; non-zero → status stays `COMPLETING`, critical incident, no silent write-off.                                                                                                                                                                                                        |
| R6 No money migration without four eyes.                                               | `ca_manual_adjustments(id, actor, approver, reason, amount, target)` with `approver <> actor`; the settle/credit functions accept `p_adjustment_id` only when that row is `approved`. A migration that credits a wallet without one fails the trigger in R3.                                                                                                    |
| R7 One rake spec.                                                                      | `ca_rake_schedule` gains `players_dealt` dimension and `heads_up_percent`; the engine loads it at boot and refuses to deal if the checksum differs from the compiled-in table; `fn_rake_law_check` uses `fn_effective_rake(bb, pot, dealt, saw_flop)` - the same function the engine mirrors - so a finding is a real deviation.                                |
| R8 The trial balance names the account.                                                | `fn_ca_trial_balance(since)` returns one row per account: balance Δ, ledger net, difference. Any non-zero difference is an incident **on that account** with the writer named (from `ca_ledger_mutation_log` / `pg_stat_activity.application_name`). Replaces "supply unexplained" as the primary alarm.                                                        |
| R9 Suspense must be zero.                                                              | `settlement_suspense` net flow per hour ≠ 0 → incident with the originating function; an undeclared money movement is a bug in the caller, not a category.                                                                                                                                                                                                      |
| R10 No direct DB writes to money tables from non-engine roles.                         | `REVOKE UPDATE` on balance columns from every role but the definer functions' owner; Supavisor/psql sessions get `permission denied`, not a trail to reconcile later.                                                                                                                                                                                           |
| R11 Horses and humans are identical on every path above.                               | Existing law 10.5; C4 must be resolved one way for both.                                                                                                                                                                                                                                                                                                        |

### 3.4 Layers of protection (defense in depth, in order of when they fire)

1. **Constraint** - CHECK/UNIQUE on escrow, obligations, keys. Fires inside the transaction. Cannot be bypassed by a retry, a migration, or a second arm.
2. **Single path** - one settle function per money movement class; triggers refuse everything else.
3. **Assertion at boundaries** - hand settle asserts the pot identity; tournament close asserts escrow = 0; spin settle asserts reserve ≥ pending.
4. **Trial balance** - hourly, per account, names the writer.
5. **Detectors** (the existing 20) - keep them, but every one gets an owner, an auto-resolve rule when its condition clears, and a 24h SLA; a detector that fires on a condition R1–R11 makes impossible is retired.
6. **Kill switch** - a trial-balance break on `tournament_escrow` or `bbj_pool` > 1,000 chips in one hour freezes new tournament payouts (obligations still accrue; settle refuses) until a human clears it. Better an hour late than paid twice.

---

## 4. Gap list - industry checklist vs. us

| Checklist item (from §1)                                  | Us today                                                                                      | Gap                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Funds on game counted as liability                        | yes (felt in supply)                                                                          | -                                              |
| Tournament prize pool held in escrow                      | **no** - counter                                                                              | **P0**                                         |
| Jackpot reserved 100% in its own account                  | yes                                                                                           | monthly reconcile missing                      |
| Double entry, balanced                                    | one row two sides; **not** balanced per transaction; suspense absorbs                         | P1                                             |
| Balances derived from journal                             | no - balances are primary, journal best-effort                                                | P1 (make writes mandatory where escrow exists) |
| Append-only journals                                      | yes                                                                                           | -                                              |
| Idempotency keys enforced by unique constraint            | partially - keys per arm, not per obligation                                                  | **P0**                                         |
| One code path moves money                                 | **no** - 11 payers                                                                            | **P0**                                         |
| Before/after balances recorded                            | `chip_ledger` has pre/post; `wallet_transactions.balance_after`                               | -                                              |
| Manual adjustments four-eyes + reason                     | **no**                                                                                        | **P0** (today's incident)                      |
| Negative balances impossible                              | wallets yes; escrow n/a; union bank can go negative on overlay                                | P1                                             |
| Restart neither loses nor duplicates                      | cash yes; tournaments: recovery sweep pays under same key as engine - ok; reconciler does not | P0 (covered by single path)                    |
| Buy-in atomic wallet→stack                                | yes                                                                                           | -                                              |
| Return at hand boundary on leave/crash                    | leave yes; crash: horses only                                                                 | P2 (fork C4)                                   |
| Rake before award, capped, NFND, weighted-contributed     | yes                                                                                           | spec split (R7) P1                             |
| Rake parameter change logged                              | no                                                                                            | P2                                             |
| BBJ fixed drop, threshold, no truncation, reseed same txn | yes                                                                                           | monthly reconcile P2                           |
| Entry split into pool + fee, re-entries same rule         | entry yes; **re-entry different rule**                                                        | P1                                             |
| Overlay funded before advertised                          | **no** (20/70 events)                                                                         | **P0**                                         |
| Cancellation refunds buy-in + fee                         | yes                                                                                           | ticket returned as ticket: **no**              |
| PKO halves conserved                                      | yes; phantom log rows on replay                                                               | P2                                             |
| Satellite seat = ticket, funded from satellite pool       | **no**                                                                                        | P1                                             |
| Spin table EV = seats × (1 − rake)                        | 2.7638 vs 2.76                                                                                | P2                                             |
| Daily trial balance naming the account                    | supply total only                                                                             | **P0**                                         |
| Break disables the game                                   | no                                                                                            | P1                                             |
| Test/house accounts labelled, excluded from revenue       | horses labelled; cert accounts reported                                                       | -                                              |

---

## 5. The fix list (what ships, in what order)

Each lane is one PR, one migration file, one changelog, its own law test. Lanes are independent so they run in parallel.

**Lane A - Obligations + exact settlement authorities (P0).** `tournament_obligations`, `fn_settle_tournament_obligation`, trigger R3, and every non-refund payer re-pointed at the generic authority (engine `TournamentManagerEliminations`, `tournamentRecovery`, `fn_tournament_payout_reconcile`, `fn_pay_backed_payout_shortfalls`, `fn_ca_backpay_guarantee_shortfalls`, `fn_backpay_spin_unpaid_winners`, `fn_backpay_hu_winner_shortfalls`, `fn_final_table_deal`, `fn_collect_bounty`, `fn_finalize_bounty_pool`, `fn_mystery_bounty_pay`). Refunds are intentionally excluded from that generic door: wallet-funded entries use `fn_settle_tournament_refund_exact`, while satellite/ticket-funded entries return through `fn_ca_return_satellite_entitlement_as_ticket`. Backfill obligations from `tournament_payouts` + `wallet_transactions` for events completed in the last 7 days so the reconciler starts from truth. Law tests require duplicate payout refusal, generic refund refusal, and exact source-instrument preservation.

**Lane B - Tournament escrow + funded guarantees (P0).** `tournament_escrow` with CHECK ≥ 0; register/rebuy/addon/satellite/overlay/settle/cancel write it; `prize_pool`/`bounty_pool`/`total_rake` become derived; `fn_apply_prize_guarantee` funds or refuses; freerolls funded from club treasury at start or pay nothing and alert; `fn_ca_backpay_guarantee_shortfalls` funds escrow **then** creates obligations, never raises `prize_pool` by fiat. Backfill escrow for live events from contributions. Law test: prize_pool > escrow is impossible.

**Lane C - Rake spec unification (P1).** `ca_rake_schedule(bb, players_dealt)`, `heads_up_percent`, `min_players_for_bbj`, per-club BBJ flag surfaced; `fn_effective_rake()`; engine boot checksum; `fn_rake_law_check` / `fn_rake_bbj_audit` rewritten on `fn_effective_rake`; the "under-rake" findings disappear or become real. Law test: engine `calculateRake` and `fn_effective_rake` agree on a 500-case table.

**Lane D - Cash-side latent defects (P1/P2).** C1 keys on `atomic_table_cashout`/`atomic_table_withdraw` (or revoke + delete); C2 remove the browser `table_seats` INSERT; C3 route the bust rebuy through `table_pending_addons`; C5 declare ledger category/counterparty in `player_leave_table` and `fn_cashout_seats_for_closing_table`; C6 mirror the four production-only RPC bodies into migrations byte-exact; C4 put to Dan as a fork.

**Lane E - Controls (P0/P1).** `ca_manual_adjustments` four-eyes (R6); `REVOKE` balance-column UPDATE from non-definer roles (R10); `fn_ca_trial_balance` per account (R8); suspense-non-zero incident (R9); kill switch on escrow/bbj break; alert board: owner, auto-resolve on clear, retire detectors that R1–R11 make impossible; retire `chip_escrow_holds`, `chip_supply_snapshots`, `atomic_tournament_register`, `fn_tournament_atomic_register`.

**Lane F - In-play chip conservation for spins/SNGs (P1, not money).** `tournament_players.chips` settle becomes the same absolute-with-assertion write as cash (`Σ chips before = Σ chips after` per hand); rebuy/add-on credits go through a pending table; `fn_spin_chip_conservation_check` should read 0 minted.

**Lane G - Satellites and tickets (P1).** `tournament_tickets` becomes the ticket_liability account; `fn_award_satellite_seat` transfers escrow → escrow; unregister returns a ticket; satellite overlay funded like any guarantee; `awardCount` capped by affordability.

Order: A and B together (they share the settle function); E's four-eyes and REVOKE the same day (they stop the bleeding from agents); then C, D, F, G.

---

## 6. Decisions that are Dan's

1. **C4 - restart sweep:** cash out everyone at a hand boundary on restart (humans and horses), or nobody. Today it is horses only.
2. **Kill switch threshold** - 1,000 chips/hour on `tournament_escrow` or `bbj_pool` proposed.
3. **Historic overpayments** - 5,330 chips (36h) and the 2026-08-26 to 08-30 baseline drifts. Standing ruling is no clawback; the hosting club absorbs. Confirm that applies to the double-paid overlays (the union bank paid 460 once; the second 460 came from nowhere).
4. **Freerolls** - funded from the club treasury at start (proposed), or advertised as "up to" with no guarantee.
5. **Rakeback owed** - 281,108.01 chips across 3 clubs (from the prior audit) still awaits your word to settle.

---

## 7. What was NOT found (so nobody re-audits it)

- Cash pot settlement is exact (11,975/11,975 hands).
- `club_members.chip_balance` movements are fully ledgered (Δ = ledger to the cent over 16h).
- Registrations debit `club_members`, not the dead `wallets` pool (repo mirror is stale; production is right).
- One `wallet_transactions` debit row per tournament entry (5,664/5,664 in 6h).
- Only one live overload of `fn_register_for_tournament` `(uuid, boolean)`; the repo's 1-arg twin is not in production.
- SNGs and satellites conserve to 0.00 over 36h.
- No hand is raked without a flop; no hand is raked over 10%; heads-up is 5%.
