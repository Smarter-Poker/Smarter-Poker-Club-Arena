# 2026-09-04 - chip standard, defect 0: the felt stops losing chips

**Branch** `fix/chip-std-felt-erasure`. **Migration** `20260904104847_felt_erasure_delta_settlement` (applied 10:48:47 UTC, mirrored byte-exact). **Restoration** in a second migration, below.

Every figure here was measured against production on 2026-09-04 between 09:50 and 12:00 UTC. The probe transcripts are summarised inline; the SQL lives in this entry so the next agent can re-run it.

## The number

`fn_ca_trial_balance('2026-09-04 08:05:00.737606+00')`, a clean hour:

| account              | balance delta | ledger net | difference |
| -------------------- | ------------: | ---------: | ---------: |
| table_stack          |      1,718.20 |   3,098.73 |  -1,380.53 |
| tournament_liability |      5,874.00 |   6,361.66 |    -487.66 |
| total_supply         |     -1,870.19 |       0.00 |  -1,870.19 |

Every other account 0.00 (player_wallets and union_banks -1.00 each). The supply meter had read -1,300 to -2,700 every hour since 2026-08-31.

## What it was NOT

Ruled out first, each with a measurement:

- **Seat exits.** All 180 exits in the hour (74,878.17 + 1,564.40) matched the `table_cashout` legs to the cent; `fn_unaccounted_seat_exits('24 hours')` returned nothing.
- **Hands not conserving in memory.** 11,444 same-player consecutive-hand pairs: the felt in `hand_history.players` moved by exactly -(rake + bbj) except where an add-on landed (all traced to a journalled add-on) and three residuals of -0.25, -0.92, -1.00.
- **Pending add-ons stranded.** `table_pending_addons`: 1,042 resolved rows in 24h, applied + refunded = amount on every row, 3 unresolved (a minute old).
- **The database drifting from memory.** 443 live cash seats on tables idle 12s+: DB stack minus the engine's last hand_history stack netted 0.00 (7 seats off by posted blinds).

So the journal claimed more chips arrived on the felt than arrived. Attributing the wallet-side legs by their table counter-entity and reconciling each same-player hand boundary against the credits journalled inside it gave the two defects.

## Defect A - erased seat credits (the leak)

A mid-hand add-on is debited from the wallet at request time (leg `addon`, `player_wallet -> table_stack`) and applied to `table_seats.stack` by `resolve_pending_addon` at settlement step 8e. If the engine's memory does not carry that credit when the next hand is dealt, the next hand's stack write - an ABSOLUTE overwrite of the row from memory - erases it. The wallet stays debited; the felt never had it; the chips are gone.

The case that proved it: horse zephyr (playing as BoatBandit) at table `a81728eb`, 747 on the felt at 08:36:37. Add-on of 1,253 debited at 08:35:59, applied to the row at 08:36:43 (row = 2,000). Hand 5807035 started at 08:36:45 with the engine holding 747: zephyr went all-in for 747, won 1,487.80, and the hand write set the row to 1,487.80. The other seats moved -747 and -10; rake 15, bbj 1.20; the hand conserved in memory. The 1,253 was overwritten.

Over 06:05-09:05: **64 add-ons / 7,685.70 chips erased, 208 landed** (same-player pairs only). Erased ones were resolved on average 5.2s after the previous hand ended and 3.7s before the next started; landed ones 3.6s and 9.2s. Every add-on in the dataset is a horse's - only the horse rotator uses mid-hand top-ups.

**Why memory missed it.** `handleHandCompleteEvent` did `this.postHandTasksPromise = wholeSettlement.catch(...)` AFTER calling `settleCompletedHand`. On the common path the body has no await before it fires `postHandTasks` (its only awaits are the insurance-shortfall alerts), so it ran to completion synchronously, assigned `Promise.all([prior, postTasks])` to the field, and returned - and the wrapper then overwrote that with a promise that was already resolved and did not include the chain. The dealing loop found a settled barrier, reloaded seats from the database before step 8e had run, dealt from the stale stacks, and the write erased the credit. Shipped in #2342 (2026-08-31 20:30 UTC); the rate rose with top-up volume (10 on 09-01, 138 on 09-04 Chicago day).

**And the write itself.** `fn_ca_settle_hand_stacks_absolute` refused 8,645 hands an hour with "seat write failed": `aaa_skip_noop_update` returns NULL for an unchanged stack, ROW_COUNT reads 0, and the function rejected the whole hand. Each of those was then persisted by the engine's unchecked per-seat fallback - absolute values, no lock, no conservation - which is also how 5 between-hands add-ons an hour were erased.

## Defect B - mis-declared tournament rake (the mask)

`fn_settle_tournament_rake` declares `prize_liability` as the source, but for a standalone club it calls `credit_club_rake_to_treasury`, which ignored the declaration and wrote its own row `table_stack -> club_treasury`. Deep Stack Society: 250 rows / 1,178.96 an hour that said the felt paid rake it never paid. Over 24h: hands took 265,544.87 of rake, legs off the felt claimed 278,737.79 (+13,192.92). This offset most of A on the meter and left `tournament_liability` short by the same amount.

A + B: -2,560 + 1,179 = -1,381 an hour. The trial balance said -1,380.53.

## What changed

**Database** (`20260904104847`):

1. `credit_club_rake_to_treasury` honours `app.ledger_counterparty` / `_entity` when set. Verified live within a minute: the next Deep Stack tournament settlement journalled `prize_liability -> club_treasury`.
2. `fn_ca_settle_hand_stacks_absolute` (same name, two optional parameters added: `p_ref`, `p_inflow`):
   - **Delta mode.** When every element carries `stack_before`, the row gets `old + (stack - stack_before)`. A credit the engine never saw is preserved by construction and recorded in `ca_seat_stack_rebases`. Conservation is asserted on the deltas on every table: `sum(delta) = inflow - rake - bbj`. A negative result refuses the whole hand.
   - **Absolute mode** (no `stack_before`) keeps the previous behaviour, so the running engine was unaffected by the apply.
   - A zero-row UPDATE whose seat already holds the target is the no-op trigger, not a failure. Verified live: 78 hands in the first 90s after apply, 0 refused (was ~27%).
3. `fn_ca_restore_erased_seat_credit` (keyed, `issuance_reserve -> player_wallet`, category refund, one mint-register row, replay refused), `fn_ca_find_erased_seat_credits` (the detector: same players, felt moved by exactly -rake-bbj, exactly one credit in the window, no other seat movement on the table), `fn_ca_restore_erased_seat_credits` (dry-run by default).

Probe, rolled back, on a live cash table: delta write conserving with one no-op seat (success, written = old + delta); replay; a simulated +100 credit on a row the engine had not seen was PRESERVED (written 854.90 = 764.90 + 100 - 10) and logged; a non-conserving delta refused with nothing written; a negative result refused; absolute mode all-no-op succeeded; `p_ref` produced a distinct hand id with `p_inflow` balancing; declared counterparty produced `prize_liability -> club_treasury`, undeclared produced `table_stack`; the detector found 36 erased credits / 1,950.32 in the prior 2h; one restored (wallet 25,000.00 -> 25,139.72, one ledger row `issuance_reserve -> player_wallet`, one register row), replay refused.

**Engine** (same PR):

- `handleHandCompleteEvent` chains onto whatever `settleCompletedHand` assigned instead of replacing it; the dealing loop's barrier wait is a `while` that re-reads the field and clears only the promise it awaited.
- `syncStacks` sends `stack_before` (from `currentHandDealtStacks`, captured at the deal for every table) plus declared rake and BBJ; retries the atomic RPC up to 5 times on transport failure; treats a refusal as final; and has **no per-seat absolute fallback**. A write with no hand number is refused. The BBJ payout's absolute "re-sync" is removed - `bbj_atomic_payout_v2` already credits the seats durably.
- `server/src/engine/TheFeltKeepsWhatLandedOnIt.law.test.ts` (19 tests): behavioural proof on the shipped prototype that the barrier does not settle before postHandTasks (fails on the old wrapper - mutation-checked), plus source and migration pins. Pins in `RestartFidelity.test.ts`, `TournamentChipsAreConserved.law.test.ts` and `StaleContinuationSweep.law.test.ts` moved from the removed fallback to the new mechanism in the same commit.

## Restoration (`20260904112929_restore_erased_seat_credits`, applied 11:29 UTC)

**282 erased credits, 33,626.88 chips, 180 players - every one a horse - restored to the club wallet each debit came from:** Club JAQK 72 / 14,224.50, Deep Stack Society 141 / 10,707.38, SHARK CLUB 69 / 8,695.00. 186 were mid-hand add-ons (`table_pending_addons` rows), 96 were between-hands add-ons erased by the unchecked fallback (the add-on leg itself). Window 2026-08-29 22:01 to 2026-09-04 10:44 UTC, i.e. everything `hand_history` still retains up to the delta-mode apply. Each restoration is keyed `seat_credit_erased:<source>:<row id>` (a replay restores nothing), journalled `issuance_reserve -> player_wallet` as `refund` with the key, one `ca_mint_ledger` row, one `chip_transactions` row of type `seat_credit_restored`. Verified after apply: 282 legs / 33,626.88 / 180 players, 282 register rows, 282 idempotency keys, 0 suspense. The migration asserts the list against the source rows and the count and total before any chip moves, and re-checks journal and register rows after.

The first cut of the detector resolved the wallet from the seat row - on a union table that is the union itself while the debit came from the member club's wallet. 107 of 282 would have gone to the wrong club. Corrected (the club on the add-on's own ledger leg, then the seat's club, then the table's) in the same migration before anything moved; two 2026-08-29/30 rows whose debit predates the declared add-on leg were resolved from their legacy `adjustment` leg.

**The deploy gap** (`20260904113047_erased_seat_credit_sweep_self_retiring`): until the engine in this PR is serving, credits keep being erased at ~30 an hour. `fn_ca_erased_seat_credit_sweep` runs at :20 over the trailing four hours (minus the last 15 minutes), restores whatever it finds through the same keyed door, files an `info` drift incident with the count, and **unschedules itself** the first time it finds nothing while the previous two hours hold only delta-mode hand writes. It is scaffolding for the gap, not a watchdog, and it removes itself when the structural guarantee is live.

## Still open, named

- `tournament_liability` residual: part of it was B (now fixed); the rest is the Phase 5 counter problem (`prize_pool` never zeroed). Re-measure after 24h.
- `ca_seat_stack_rebases` should read near-empty once the engine half is deployed. A steady rate there means another writer credits seats outside the engine's view; each row names the seat and the amount.
- Partial erasures (a hand boundary with more than one credit, or a credit plus a buy-in) are not restored by the conservative detector: 14 rows / ~1,500 chips over the window read "landed_amt not equal to applied and not zero". They need hand-by-hand attribution; listed by `fn_ca_find_erased_seat_credits` complement, not built.

## Addendum 19:30 UTC - the detector in delta mode, and 15 credits paid twice

Found while closing Phase 3: the deploy-gap sweep kept restoring credits in hours (15:20, 16:20, 17:20, 18:20) when the engine could not have erased anything. Read case by case: every one of those credits had been preserved by the delta write (a `ca_seat_stack_rebases` row, or the next hand's stack carrying it) and the boundary hand's `ca_settlements` row says `mode = delta`. The detector's evidence is `hand_history`, which is the engine's memory; in the absolute era a quiet memory boundary meant the row had been overwritten, in delta mode it means the row kept what memory missed. The sweep never retired itself because those false positives kept its "nothing to restore" condition false.

**15 credits, 3,867.99 chips, 14 club wallets, restored a second time** (15:20-18:20 UTC; all `addon_leg` source; every pre-15:00 restoration was checked and is absolute-era, genuine). Per CLAUDE.md 10.9 rule 3 they stay where they are: our defect, absorbed, not clawed back. They are already in `ca_mint_ledger` as issuance, which is what they are. Incident `erased-seat-credit-sweep-false-positives:2026-09-04` carries every transaction id and wallet, resolved with the migration as correction.

`20260904192338_the_erasure_detector_knows_delta_mode_and_the_sweep_retires`: the detector excludes any boundary whose hand has a delta-mode settlement row (asserted: the corrected detector finds nothing since 14:00 UTC); the sweep unscheduled (by hand at 19:14:51, six minutes before its next run, repeated in the migration) and its function dropped; the 15 asserted by count and sum before the incident is filed. The structural guarantee has been live since the 12:55 cutover with zero absolute-mode writes; the cron existed only for the gap.

**Rebases are the mechanism working, not a leak.** 141 rows / 681,948.66 by 18:48 UTC, 139 distinct seats, 55 tables: almost all tournament break add-ons (12,000 chips for a 1.00 wallet cost) and cash top-ups that landed on the row while the engine was mid-hand. Each is one-shot, and the engine carries the chips from the next deal (verified: 14,899 -> 26,899 on the following hand). Before delta mode every one of those was erased.
