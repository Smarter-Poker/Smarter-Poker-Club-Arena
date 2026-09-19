# The band-aid register

**Opened 2026-09-07.** The rule that created it is CLAUDE.md **10.12 — no
band-aids**. Every row here is a piece of machinery that exists because
something upstream does not work. Each one is DEBT with a named root fix, and
**deleting the band-aid is part of that fix**.

A real poker room pays the winner when the hand ends. Everything on this page
is the platform failing to do that and something else tidying up afterwards.

> Nothing here may be closed by making the band-aid better, more frequent, or
> better instrumented. It closes when the live path cannot produce the wrong
> outcome and the job is **deleted**.

## 2026-09-10 control-plane retirement and fee boundary

The 60-second `club-arena-supervisor.service` / `.timer` mutator is retired.
The installer disables, stops, removes, reloads, and proves both units absent.
Its historical `engine-supervisor.sh` filename remains only because release-v1
freezes that generation entrypoint; the executable now refuses every call
unless the release transaction or its ExecStopPost recovery supplies all three
causal authorities (force desired, exact health, and caller-held engine lock)
plus an absolute deadline. Sampling counters, cache-tag reconciliation,
heartbeat metrics, and autonomous container mutation are gone. The monitoring
rule file is consequently `recovery-rules.yml` and observes the daily read-only
recovery audit rather than a mutating heartbeat.

Two watcher-shaped surfaces are explicitly **not closed** by that change:

- `sp-autoheal` still watches Docker health and restarts an unhealthy engine.
  Plain Docker does not act on an unhealthy healthcheck, so deleting autoheal
  before a separately audited, causal process-failure owner lands would remove
  the only recovery for a live-but-wedged process. It remains a named blocker,
  not a claimed retirement.
- GameServer's `FeeReconciler` mixes a legitimate durable obligation drain with
  historical scans, audits, and repair calls. In particular, a BBJ payout is
  persisted to `pending_fee_distributions` before its first delivery attempt;
  deleting the drain can strand a real jackpot obligation. The safe split is:
  keep an atomic claim-and-deliver outbox worker, wake it from the write that
  creates an obligation, retry only within that causal chain, and perform one
  bounded startup drain for crash recovery; move read-only audits out of that
  worker; then remove the five-minute interval and the hourly/30-minute repair
  scans only after the accepted-hand post-commit envelope is proven universal
  and the old backlog is zero. No fee/tournament runtime was changed in this
  control-plane pass.

`scripts/ci/band-aid.allowlist.json` has no supervisor exemption to delete. Its
BBJ repair entries remain because those database repair functions and schedules
were not safely retired in this pass; removing only their CI names would hide
debt rather than remove it.

---

## What this costs today, measured

All figures read from production on 2026-09-07 over the **last 7 days** unless
stated.

**Money paid by repair machinery instead of by the engine:**

| payout `source`       |    rows |         chips | events | median lateness | worst    |
| --------------------- | ------: | ------------: | -----: | --------------- | -------- |
| `reconcile`           |     342 |     32,849.99 |    191 | **6.3 hours**   | 84 days  |
| `overlay_backpay`     |     173 |     14,596.70 |     40 | **8.4 days**    | 11 days  |
| `unclassified`        |      32 |        161.30 |     15 | **105 days**    | 117 days |
| `late_reg_adjustment` |      10 |        532.55 |      6 | 0 min           | 0 min    |
| `spin_backpay`        |       1 |          6.40 |      1 | 25 min          | 25 min   |
| **total**             | **558** | **48,146.94** |        |                 |          |

Against the correct path — `structure`, 77,260 rows / 4,515,971.30 chips — that
is **0.7% of payouts and 1.1% of the money**, and every one of those players
waited. The median MTT/Spin winner in that set waited **six hours**.

**How often the engine gets it wrong:** 74,544 tournaments completed; **108
needed the reconciler** — about **1 in 690**. Split by shape:

- **69 events / 27,807.56 chips** — the engine paid SOME places and stopped.
- **39 events / 3,864.94 chips** — the engine paid **nothing at all**.

**Two hypotheses tested and rejected**, so nobody re-tests them:

- _The :55 maintenance freeze._ 3.7% of reconciled events ended in the
  :53–:59 window against a 3.2% baseline. No signal.
- _The escrow refusing._ Only **4 of 191** reconciled events carry an
  `escrow_short` alert.

**Still owed right now:** 7 open `tournament_obligations`, **432.17 chips** —
360.00 of which is item #11 below, and it is Dan's decision, not a defect.

**Repair jobs that fired in the last 7 days** (each fire = a player served
wrongly and something else cleaning up):

| repair                                                 | fires 7d | newest      |
| ------------------------------------------------------ | -------: | ----------- |
| `fn_tournament_payout_reconcile` alerts                |      139 | 09-07 00:33 |
| `FeeReconciler.bbj_unlinkable`                         |      114 | 09-06 03:00 |
| `FeeReconciler.prize_disbursement`                     |      111 | 09-07 12:05 |
| `FeeReconciler.satellite_conservation`                 |       52 | 09-07 17:08 |
| `drift_incident: quick_reconcile ledger_write_failure` |       55 | 09-07 00:05 |
| `fn_rake_repair_unbanked`                              |       22 | 09-07 08:52 |

**Scheduled surface:** 127 active `cron.job` rows — **29 repair-shaped**, 27
monitor-shaped, 35 housekeeping, the rest product.

**Function surface: 50 band-aid-shaped functions live in `public` today**, 15 of
them `backpay`/`backfill`. `node scripts/ci/check-no-new-band-aids.mjs --all`
lists the 27 that this register does not yet have a row for, among them:

```
fn_backpay_hu_winner_shortfalls        fn_ca_backpay_guarantee_shortfalls
fn_backpay_spin_unpaid_winners         fn_ca_overlay_shortfall
fn_backpay_tournament_rake_attribution fn_ca_repair_write_failure
fn_repair_seat_first_games             fn_repair_tournament_rake_attribution
fn_backfill_unranked_survivors         ca_repair_hand_player_stat_money
fn_backfill_rake_attributions          fn_club_table_daily_catchup
```

**And the three Dan named himself.** He said _"LIKE THE BOMB POTS NOT PAYING OUT
OR HAVING ISSUES"_. Bomb pots have **three** separate band-aids:

```
fn_backfill_bomb_pot_award_units
fn_backfill_bomb_multi_winner_units
fn_ca_bomb_pot_catchup
```

Three plasters on one wound is the whole argument for 10.12. A bomb pot that
paid correctly the first time would need none of them.

---

## TIER 1 — money band-aids. These die first.

### 1. `fn_tournament_payout_reconcile` (all applying repair doors retired)

**What it was.** An hourly sweep that recomputes every completed tournament's
payout structure and pays whatever the engine did not. It is the single largest
band-aid on the platform: **342 payouts, 32,849.99 chips, 191 events in 7 days**,
median 6.3 hours after the player finished.

**Root cause - two forms of the same split transaction.**

- _Partial settle_ (69 events, 27,807.56 chips): the engine pays place 1..N and
  stops. The settle loop is not atomic — a failure part-way leaves the earlier
  credits committed and the rest unwritten, and nothing retries **inside** the
  settle.
- _No settle at all_ (39 events, 3,864.94 chips): the event reaches COMPLETED
  with zero payout rows.

**Root fix implemented on `fix/tournament-settle-is-atomic`.** Normal elimination
and late-registration repricing now record entitlement only. Finish and
stuck-`COMPLETING` recovery first commit the complete structure plan to
`tournament_obligations` with a count/total/fingerprint header. One database
exception subtransaction then pays the exact Bubble Protection promise, when
one exists, and every prepared place; proves the exact escrow consumption and
ledger evidence; marks the batch settled; changes `COMPLETING` to `COMPLETED`;
releases every live seat; closes every physical tournament table with zero
current players; and proves that no nonterminal table or live seat remains. A
refused or partial child leg, evidence mismatch, closure failure or lost status
claim raises and rolls the money, batch, terminal status, tables and seats back
together. A final, alphabetically-last database trigger also refuses any normal
`COMPLETED` write without the exact fully-paid batch, including legacy direct
writers. A separate status lock makes every normal `COMPLETED` row terminal,
prevents a prepared normal batch from leaving `COMPLETING`, and permits only
the fully settled `COMPLETING` to `COMPLETED` transition. The deal-specific
lock applies the same rule to its `RUNNING` to `COMPLETED` transition.

The public `fn_settle_tournament_obligation` signature is now a classification
gate. It preserves the legitimate non-structure and satellite paths, but normal
`place`, `late_reg_adjustment`, `bubble_protection` and `final_table_deal` calls
return `atomic_batch_required`. The audited child implementation was renamed to
the private `fn_settle_tournament_obligation_before_atomic_batch_gate`; all
application roles, including `service_role`, are denied that core. Only the
normal-place and final-table-deal batch functions may call it after proving and
freezing their complete plans.

Finalization is now an irreversible money contract. The public guarantee gate
atomically proves the exact bank debit, overlay row, explicit journal leg, live
escrow credit and finalized pool; its debit core is private. A finalized pool
cannot be reopened, and its pool, guarantee, payout structure and Spin draw
cannot be changed. Registration, rebuy and add-on doors refuse a finalized
pool, finalization refuses while a promised entry or add-on window remains
open, and prepare, settle and completion all refuse a finalized pool below its
advertised guarantee.

Bubble Protection now keeps truthful, durable provenance. The application no
longer pays it at elimination. Normal batch preparation derives the exact
stone-bubble holder only after standings and the finalized field are frozen,
using `engine.atomicPlaceSettlement`; it also recognizes an exact pre-existing
`engine.eliminatePlayer` obligation and rejects every other obligation source.
The payout record remains distinct evidence with source `bubble_protection`, a
null position and the exact Bubble player. Clearing a display flag cannot hide
an existing Bubble obligation or payout. The separate final-table-deal batch
uses its own atomic Bubble source and contract.

Every applying repair entrance is retired. `fn_tournament_payout_reconcile`,
`fn_pay_backed_payout_shortfalls` and `sp_ca_reconcile_backpaid_events` reject
`p_apply=true` before scanning. `fn_backpay_hu_winner_shortfalls` is replaced
by an owner-run observation with no applying mode at all. Every application ACL
is revoked. The
engine's five-minute Heads-Up applying loop is removed so it cannot endlessly
rescan normal place calls refused by the new batch boundary. Application access
to the older payout-sweep and guarantee-backpay
functions is also revoked, every matching applying cron command is unscheduled,
`ca-payout-sweep-hourly` is removed from the legacy expected-job roster when
that roster exists, and no replacement payer, cron or backfill worker is
created. The engine daemon's applying sweep is removed as well.

**Existing damage was classified before touching money.** Seven obligations
remain open for 432.17. The two 180.00 Bubble Protection gaps are Dan's reserved
pricing/funding decision. The other five rows total 72.17, but every affected
pool is already fully distributed: 71.25 is stale state from a final-table
deal, 0.60 is a sticky Spin obligation after a ladder repair, and the remaining
0.32 is exactly offset by overpaid places in two events. Safely payable backlog:
**0.00**. Paying any of it would create an over-disbursement, so this change
makes no compensating wallet write and performs no clawback.

**Delete when:** `tournament_payouts` records zero rows with
`source = 'reconcile'` for 30 consecutive days. The function stays on the debt
list until that production observation is true; keeping a dormant legacy
function during its stated deletion proof is not permission to call it.

---

### 2. `fn_pay_backed_payout_shortfalls` + `ca-pay-backed-payout-shortfalls-hourly`

**What it is.** An hourly job that pays shortfalls the settle path refused.

**It is also broken.** It calls a 59 ms function inside its `WHERE` against
112,298 COMPLETED tournaments — about 110 minutes of work under a 120-second
`statement_timeout`. Its `LIMIT` stops early only once 500 rows _pass_, so **it
succeeds when a lot is owed and times out when little is** — the residual
shortfalls are exactly the ones it can never reach. Measured failures in 7 days:
6 of 135 runs, all `canceling statement due to statement timeout`.

**Root cause.** The settle refuses to pay from a bank it believes is short. Two
of the three known cases so far were the bank being wrong, not short (see #4).

**The hard fix.** #1 above removes the need. Until then the predicate must be an
indexed column, not a function call.

**Delete when:** #1 lands and `tournament_obligations` has no open row for 30 days.

---

### 3. `fn_backpay_unfinalised_bounty_pools` + `ca-bounty-backpay-hourly`

**What it is.** Pays out bounty pools that were funded and never distributed.
**9 of 138 runs failed in 7 days**, one with
`fn_finalize_bounty_pool: residual of 2310.00 ... in tournament 3f19bd70` — so
the band-aid itself is leaving 2,310.00 chips undelivered.

**Root cause.** A bounty event funds a SECOND pool from the same buy-in, and the
settle path finalises the prize pool without finalising the bounty pool. 34 of
38 affected events were completed by the stuck-tournament watchdog, which
settles rake and never touches bounties.

**The hard fix.** One settle, both pools, one transaction. A tournament is not
COMPLETED until every pool it funded is distributed — enforced by a constraint,
not by a job.

**Delete when:** no completed bounty event holds an undistributed bounty pool
for 30 days.

---

### 4. `overlay_backpay` (guarantee overlays paid late)

**What it is.** 173 payouts / 14,596.70 chips across 40 events, **median 8.4
days late**. A guarantee overlay is the house topping a pool up to the promised
guarantee; these are events where that money arrived more than a week after the
player won it.

**Root cause.** The overlay is not funded into the prize bank at settle time, so
the structure cannot be paid in full and the remainder waits for a later pass.

**The hard fix.** The overlay is funded **when the guarantee is declared short —
at the moment the event closes registration**, not after settlement. An event
whose pool is below its guarantee at close is either topped up then or does not
start.

**Delete when:** `overlay_backpay` records zero rows for 30 days.

---

### 5. `fn_rake_repair_unbanked` + `fn_redrive_unbanked_rake` (two jobs, 15-minutely and quarter-hourly)

**What it is.** Rake taken from a pot that never reached a bank. The alert says
it plainly: _"Recovered N unbanked rake hand(s) ... (engine did not survive to
bank them)"_. **22 fires in 7 days, newest today 08:52.**

**Root cause, named — CORRECTED 2026-09-07, and it was not what this row said.**
The paragraph below used to read "the engine takes rake from the pot and banks
it in a SEPARATE step. Between the two it can die — and with an hourly `:55`
restart it reliably will." That is a good story and the measurement does not
support it: the orphans do NOT cluster at `:55` (the `:55` five-minute bucket
has **zero** of them, because play is parked), and the engine surviving is not
the variable.

What was actually happening, read from rows on 2026-09-07:

`hand_history.id` defaulted to `gen_random_uuid()`, so settlement could not know
the hand's identity until the INSERT came back. When that insert was slow or
failed — 143 of 11,485 hands in two hours landed more than 30 seconds after
`ended_at`, 66 of them over two minutes, worst 252s — the hand went to the retry
queue and the rake was banked with **`p_hand_id => NULL`**. That one null cost
three separate things:

- **nobody earned.** `atomic_distribute_rake` writes `rake_attributions` only
  `IF v_first_claim AND p_hand_id IS NOT NULL`. 173 cash hands in 24 hours, and
  **zero** attribution rows between them: no VIP points, no agent or super-agent
  commission, no rakeback basis, for every player at those tables (10.5);
- **the unique index was off.** `uq_rake_records_hand_id` is `UNIQUE (hand_id)
WHERE hand_id IS NOT NULL`. 36 hands in seven days carried two or three copies;
- **the club was paid twice.** `v_leg_key` is `COALESCE(p_hand_id,
md5('rake:'||table||':'||hand_number))`, so the live call and this row's own
  re-drive took different keys and `rake_distribution_legs` deduped neither.
  99 hands, 166.38 chips of rake and 26.18 of BBJ drop that no pot ever paid.

**The hard fix — SHIPPED 2026-09-07.** `ServerTableEngineSettlement` mints the
hand's uuid itself before anything is written and gives the same value to the
`hand_history` insert, to `atomic_distribute_rake` and to the BBJ contribution.
The row then lands under that id in line, from the queue minutes later, or never
— and the booking names the same hand either way. Pinned by
`server/src/engine/aHandNamesItselfBeforeItBanksItsRake.law.test.ts`. The club
accumulators were corrected by `20260907200330`; the doubled VIP points stay
with the players (10.9 rule 3, absorbed and reported).

Note this makes the pot/bank atomicity above **unnecessary**, not merely
deferred: the second write is now idempotent on the hand, so a death between the
two steps is repaired by the next call rather than by a job.

**Delete when:** `I7_raked_hand_never_banked` returns zero for 30 days with the
repair job **off**. Both jobs are now expected to find nothing; a fire is a P0
that says the mint regressed.

---

### 6. `FeeReconciler.prize_disbursement` — 111 fires in 7 days

**What it is.** A daily-ish critical saying _"N completed tournament(s) in the
last 24h paid out more than their prize pool"_. This is the opposite failure:
the platform paying out **more** than it collected.

**Root cause: not yet named.** It has not been investigated. It is the highest
priority unowned item on this page, because over-payment cannot be recovered
from a player (10.9 rule 3) — every occurrence is a permanent loss.

**The hard fix.** Unknown until read. The likely shape is the same as #1: a
place paid twice by two paths that do not see each other.

---

### 7. `FeeReconciler.satellite_conservation` — 52 fires in 7 days, newest 17:08 today

**What it is.** Completed satellites whose chips in do not equal chips out.

**Root cause: not yet named.**

**The hard fix.** A satellite seat award and the pool transfer that funds it
must be one transaction, asserted at commit.

---

### 8. `credit-stalled-seat-first-stacks` — **RETIRED 2026-09-08**

**What it was.** A cron that credited a seat's first stack when the seat existed
and the chips never arrived. It moved game-deciding chips every minute forever.

**Root cause fixed.** Migration
`20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing` makes a
live tournament seat's positive stack a BEFORE-trigger invariant, before every
engine or money-path bypass. A canonical seat-first seat must equal the board's
positive `tournaments.starting_chips`. The paid-third-seat AFTER hook now
propagates count or Spin-booking failure into the seat transaction rather than
catching it and committing a half-built field.

**Retirement proof.** The migration takes the cron job's advisory lock, holds
the scheduler roster plus all five source tables against writers, proves the
old function's exact candidate set is empty, proves every active pre-deal
tournament seat is positive, and proves exact seat/roster stack parity for
canonical seat-first games. It then unschedules every normalized name/command
match and drops `fn_credit_stalled_seat_first_stacks()` with `RESTRICT`, all in
that transaction. The scheduler lock prevents a concurrent reschedule between
the final scan and commit.

The production snapshot at 2026-09-08 07:18 UTC found **0** old-job candidates,
**114** active pre-deal canonical seat-first games, **194** live seats, **0**
wrong seat stacks, **0** roster-status mismatches, **0** roster-chip mismatches,
and **0** paid active roster entrants without a live seat. The earlier “zero
credits for 30 days” gate was not measurable: `cron.job_run_details` retained
about 15 days and every successful invocation recorded only `1 row`, not the
function's returned credit count. The locked structural proof is stronger and
is the actual deletion gate.

---

### 9. Spin booking, multiplier and winner-backpay fleet — **ROOT FIX BUILT; RETIREMENT STAGED**

**What it was.** `fn_spin_sweep_unbooked` repaired entries never booked into
the reserve, `fn_spin_repair_missing_multiplier` reconstructed multiplier
state, and `fn_backpay_spin_unpaid_winners` paid a winner after a split draw,
journal or payout path. The first two schedules ran **2,014 and 671 times in 7
days**; GameServer called winner-backpay every ten minutes.

**Root cause fixed.** The paid-third-seat hook now propagates booking failure
into the seat transaction, so the paid seat, roster, count and reserve entry
cannot split. `fn_spin_draw_and_settle` then locks the tournament and reserve,
books/replays that entry, selects only a funded tier, commits its draw, journal,
escrow and tournament contract, and returns one exact receipt. The server calls
only this authority and refuses to reveal or deal without validating the whole
receipt. Its separate draw, settle and ledger-adoption paths are gone.

The recurring GameServer winner-backpay timer/caller is removed. The two known
historical incidents are handled by exact asserted migration blocks rather
than by an open-ended payer.

**Retirement gate.** The staged post-publish cleanup does not trust deployment
order or elapsed time. In production it requires a complete atomic receipt for
a new Spin outside the audited historical cohort, proves the full unpaid view
has no positive shortfall, proves every relevant reserve/journal/escrow and
tournament contract is exact, and checks that no repair invocation is running.
It owns both reconstruction-job advisory locks, freezes the scheduler roster,
and recreates plus verifies all three receipt/contract enforcement triggers.
Only then does it unschedule every active or disabled spelling, drop the sweep,
reconstruction, winner-backpay and old draw functions, and revoke service-role
access to the raw settle/book primitives. Until that receipt exists, the
database functions remain rolling-cutover compatibility doors, not live server
callers.

**Related and already fixed today:** the escrow could not see a Spin's reserve
draw because the derived `chip_ledger` leg went missing (1 of 18,318). It now
reads `spin_reserve_ledger` directly — see
`docs/changelog/2026-09-07-a-spin-prize-comes-from-the-reserve.md`. **That one
is a root fix, not a band-aid**, and it is the model for this page: the escrow
stopped depending on a leg that could be absent.

---

### 10. `unclassified` payouts - root fix implemented

**What it is.** Payout rows whose `source` nobody set. A money row with no
provenance is unauditable by definition. The 32-row, 161.30-chip cohort was
traced to one exact cause: the 2026-09-01 vacant-place repair used keys shaped
as `tourney:<id>:vacantplace:<user>:<place>`, but the shared payout classifier
did not know that grammar and the credit funnel substituted `unclassified`.

**The hard fix.**
`every_tournament_payout_names_its_source` removes the legacy `payout` default,
keeps `source NOT NULL`, adds a validated `CHECK` against the complete source
vocabulary, and makes `fn_credit_and_log` reject an unresolved or unknown
source before the wallet move. The shared classifier now maps the exact
`vacantplace` grammar to `finish_position_correction` and its encoded place.

The same migration corrects only the 32 exact historical rows. A digest pins
every payout, recipient, event, amount, key, timestamp and repair fact; all 32
must also match their wallet idempotency claim. Each metadata-only change gets
an immutable receipt in `tournament_payout_source_corrections`. The cohort's
32 wallet claims still total 161.30 before and after, so no chips move.

**Closure proof.** Zero rows may remain as `unclassified`; an omitted source
fails `NOT NULL`, an unknown source fails the closed `CHECK`, and the atomic
credit door refuses both cases before crediting. There is no watcher,
reconciler, fallback label or scheduled repair for this rule.

---

### 11. Bubble protection is reserved from the prize pool - root fix implemented

Dan decided that Bubble Protection is funded by the tournament prize pool,
never the house bank. The old path paid the Bubble one buy-in but still priced
the normal ladder against 100% of the same pool. That double allocation then
appeared as a false winner shortfall.

Both _Sunday $200 Deep Stack_ events on 2026-09-06/07:

| event      | prize pool |  paid out | of which Bubble Protection | stale obligation tail |
| ---------- | ---------: | --------: | -------------------------: | --------------------: |
| `a449e853` |  28,640.00 | 28,640.00 |                     180.00 |                180.00 |
| `f7412940` |  52,920.00 | 52,920.00 |                     180.00 |                180.00 |

**The hard fix.** The database now reserves exactly one base buy-in before it
prices the percentage ladder. Bubble plus all paid places therefore equal the
locked prize pool exactly. The Bubble payer can spend only that pool escrow;
there is no club-wallet or house-bank fallback. Satellites remain separate:
their complete tickets are paid first and every sub-ticket residual chip goes
to exactly one next finisher.

The two production events above had already paid every chip in their pools,
including the Bubble buy-in. Their 180-chip rows were stale allocation
metadata, not unpaid money. The six-event evidence migration records each
exact full-pool proof and retires only those named obligation tails without a
wallet, payout, escrow, ledger, rake, or bank write.

**Closure proof.** The atomic cash settlement writes the Bubble debt before
the first credit, pays it and every ladder place in one transaction, and
requires payout total = locked pool before terminal completion. A failure
rolls the complete finish back. Tests pin the pool subtraction, exact one-buy-in
amount, single stone-Bubble identity, no house funding, and exact replay.

---

## TIER 2 — state and denormal repairs

These do not move money directly, so they hide behind the money ones. Every one
still means a live write is wrong.

| job                                                 | function                                | cadence   | what it repairs                                 | the hard fix                                                       |
| --------------------------------------------------- | --------------------------------------- | --------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `reconcile-tournament-denormals`                    | `fn_reconcile_tournament_denormals`     | **1 min** | denormalised tournament counters                | derive them, or write them in the same transaction as their source |
| `ca-auto-reconcile-tick`                            | `fn_ca_auto_reconcile_tick`             | **1 min** | ledger drift                                    | the writes that drift are the defect                               |
| `union-seat-provenance-heal`                        | `fn_heal_seat_provenance`               | 5 min     | seat rows with no provenance                    | provenance written with the seat, `NOT NULL`                       |
| `ca-quick-reconcile-5m`                             | `fn_ca_quick_reconcile`                 | 5 min     | ledger imbalance (55 write-failure drifts/7d)   | fix the failing ledger write                                       |
| `ca-escrow-ttl-sweep-10m`                           | `fn_ca_escrow_ttl_sweep`                | 10 min    | escrow rows left open                           | close the escrow in the settle transaction                         |
| `ca-promo-accrual-retry-10m`                        | `fn_ca_retry_promo_accruals`            | 10 min    | promo accruals that failed                      | accrue in the transaction that earned it                           |
| `ca-bbj-repair-unbanked-15m`                        | `fn_bbj_repair_unbanked`                | 15 min    | BBJ drops taken and not banked                  | same one-write fix as #5                                           |
| `spin_repair_missing_multiplier`                    | `fn_spin_repair_missing_multiplier`     | 15 min    | spins whose multiplier was never written        | write it in the transaction that draws the prize                   |
| `bbj-rollup-catchup`                                | `fn_bbj_rollup_catchup`                 | hourly    | rollups that missed rows                        | roll up from an outbox that cannot lose a row                      |
| `club-rake-rollup-catchup`                          | `fn_club_rake_rollup_catchup`           | hourly    | rollups that missed rows                        | same                                                               |
| `ca-ledger-day-manifest`                            | `fn_ca_ledger_day_manifest_backfill`    | daily     | manifest days never written                     | write the manifest for a day when the day closes                   |
| `sp_resolve_settled_prize_alerts_15m`               | —                                       | 15 min    | alerts about money that has since settled       | a check that resolves its own alerts (done today for two of them)  |
| `reconcile-club-table-counts-nightly`               | `fn_reconcile_club_table_counts`        | nightly   | club table counts                               | count from the source, do not store a second copy                  |
| `reconcile-club-member-daily-profit`                | `fn_reconcile_club_member_daily_profit` | nightly   | member profit                                   | same                                                               |
| `reconcile-ledger-integrity-6h`                     | `reconcile_ledger_nightly`              | 6 h       | ledger vs stored balances                       | the writes that drift are the defect                               |
| `ca-escalate-reconcile-criticals-hourly`            | `fn_ca_escalate_reconcile_criticals`    | hourly    | criticals nobody actioned                       | Tier 3: a check that clears itself needs no escalator              |
| `flag-garbage-tournaments`                          | `fn_flag_garbage_tournaments`           | nightly   | tournaments that should never have been created | refuse to create them                                              |
| `ca-pgrst-reload-if-stale`, `pgrst-reload-watchdog` | —                                       | 5/15 min  | PostgREST schema cache not reloading            | the DDL policy in CLAUDE.md §2 — one transaction per change        |

Retired 2026-09-10: `ca-eliminate-absent-players` and
`ca-release-broke-seats`. Both wrote `tournament_players.status = 'eliminated'`
with **no finishing place** in RUNNING events, ten minutes after an accepted
hand had already busted the player and while the engine's knockout door was
still holding that bust. `fn_complete_tournament_entry_reprice` counts a
placeless eliminated row as an unfinished reprice, so the proof refused for
ever and `runEliminationSweep` returned before its bust stage: twenty
tournaments stopped recording eliminations entirely, and the sweep then took
the next batch of stranded busts. All 1,270 rows it had taken carried a
`pending` knockout candidate. Both jobs are now INACTIVE (the row is kept, not
deleted - the unapplied retirement chain 20260910000850 captures exactly two
and its CHECK demands two), both functions refuse any bust a hand took, and a
DEFERRED constraint trigger refuses a placeless elimination in a live event
whoever writes it. Root fix and measurements:
`docs/changelog/2026-09-10-the-knockout-door-owns-every-bust.md`.

**The lesson this cost:** eight hours earlier
`docs/changelog/2026-09-10-the-felt-decides-who-busted.md` had fixed this same
sweep to read the felt rather than a stale mirror. That fix was correct on its
own terms and it is what made the loop possible - a broken band-aid was
harmless, a working one raced the live path. When you find a repair job that
is not repairing anything, do not fix the repair job; ask what the live path
was doing with those rows.

Retired 2026-09-07: `sweep-seatless-late-registrants`. The registration RPC
now creates capacity, debits the entrant, writes the roster and claims the seat
inside one tournament-row-locked transaction. The release migration removes
every cron row named for, or directly invoking, the former repair function and
then drops the callable repair function itself. It asserts that neither the
schedule nor the second correctness door remains.

---

## TIER 3 — monitors that must never be mistaken for a fix

27 scheduled checks exist. They may stay as nets **only where a root fix has
landed and the net is expected to find nothing** (10.11 rule 5). None of them
closes an item on this page.

Two were repaired today so they can no longer lie:

- `fn_payout_guarantee_check` — raised a critical alert and **could never close
  one**. Five of its six open alerts were false; the reconciler acting on one of
  them tried to pay 23.75 twice. It now requires an undistributed pool and
  resolves its own alerts. Open `earner_not_paid`: **0**.
- `fn_rake_bbj_audit` — 24 criticals open since 08-31 while its invariants had
  returned zero for 21 hours. Now clears itself. Open: **0**.

**The same defect is probably in most of the other 25.** Any check that raises
into `financial_alerts` and has no resolve path is on this list by default;
220 alerts are open right now and the two audited today were 100% and 83% stale.

---

## What is NOT a band-aid, so nobody deletes the product

Scheduled work whose schedule **is** the thing: tournament starts and blind
levels, the `:55` maintenance break, retention pruning
(`sp_prune_hand_history`, `cron-history-retention-daily`, and the rest),
snapshots for reporting (`ca-supply-snapshot`, `index-usage-snapshot`),
digests and reminders, `managed-game-schedules`, `home-*` scheduling,
leaderboard settlement on its published cadence.

---

## The order to work in

1. **#1 the settle transaction.** It is 68% of the money and it makes #2 and
   most of #4 unnecessary.
2. **#6 over-payment.** Unowned, unread, and the only class that cannot be
   recovered from the player.
3. **#5 rake banked in one write** — fires daily, cause already named, small.
4. **#8 seat and stack in one transaction** — a money cron running every minute.
5. **#3 / #7 / #9** — one transaction each, same shape.
6. **Tier 2**, in cadence order: anything running every minute first.
7. **Tier 3**: give every check a resolve path, then delete the ones whose cause
   is fixed.

Each item is finished when the live path cannot produce the wrong outcome, a
test pins the cause, the damage is settled through the platform's own idempotent
path, **and the job is gone from `cron.job`**.

## 2026-09-12 the BBJ promo sweep, and why it is listed here without being a band-aid

The phase 2 BBJ sweep flagged that `fn_sweep_bbj_promo` "moves money
continuously with no cron row in this repo and no entry in
`docs/BAND-AIDS-REGISTER.md`". This is that entry, and it is deliberately a
**NOT-A-BAND-AID** row: the point of writing it down is that the next agent
stops re-discovering it and reaching the wrong conclusion.

**What it does.** `bbj_record_contribution` accrues the 25% promo slice into
`bbj_pools.promo_balance` on every contribution - 46,814 of them in 24 hours -
and **`fn_sweep_bbj_promo_all()`** moves the accrued amount to
`union_wallets.promo_wallet`, or to `clubs.promo_balance` for a club with no
union. Measured 2026-09-12: 1,791 sweeps in seven days moving **24,965.28**,
one per five-minute boundary, the `:00` run absent each hour because the
platform is frozen for the maintenance break.

> **CORRECTED 2026-09-12, ninety minutes after this row was written.** The
> first version of this entry, and the production comments that went with it,
> named the per-club `fn_sweep_bbj_promo(uuid)` as the driver. It is not.
> `smarter-poker-workers/src/routes/bbj-detect.ts` step 6 calls
> `fn_sweep_bbj_promo_all`, and nothing in that repo calls the per-club one.
> I had measured that _something_ swept every five minutes and assigned the
> role by inference. Worse, I recorded here that the workers repo "isn't
> mounted in this session" - it is on this machine at
> `~/Documents/smarter-poker-workers`, and one `grep` settles it. Migration
> `20260912005352` corrects both comments.

**Why it is not a band-aid.** It repairs nothing and compensates for nothing.
It is the transfer itself, batched, and the batching is the design rather than
a tidy-up: crediting one `union_wallets` row inline on 46,814 contributions a
day is a lock-contention problem, not a correctness improvement. CLAUDE.md
10.12's own carve-out is "a job whose schedule IS the product", and this is one.
If a future change makes the inline credit cheap, the staging slot and the
sweep both go - but that is an optimisation, not a debt being repaid.

**What WAS wrong, and is fixed (migration `20260912003749`).** Nothing in this
repo could see it. No `cron.job` row names it, no trigger fires it, and no
TypeScript in Club Arena or the World Hub calls it. **The driver is a third
repo**: Open Claw dispatches `/api/cron/bbj-detect` on `*/5`, and
`scripts/openclaw-cron-dispatcher.py` line 1022 records that the route now
lives in the workers repo as `src/routes/bbj-detect`. So an agent auditing
Club Arena finds a `SECURITY DEFINER` function that moves real money, finds no
caller anywhere it can see, and concludes it is dead. That happened during this
very audit, from `promo_balance = 0.00` on every pool - the zero is the sweep
working, not the slice being banked inline. The function now names its driver
in its own `COMMENT`.

**And the trap that came with it.** `fn_sweep_bbj_promo_all`'s original comment
ended by telling the next agent to schedule it. That was wrong in the opposite
direction from how I first read it: the function **is already driven**, from
the workers repo, so the sentence invites a _second_ driver onto the same
staging slot - `_all` looping every pool `FOR UPDATE` against the live run five
minutes later, racing over the promo slice of every raked hand on the platform.
It now states that it is the live driver, names the route, and says never to
add a second one. The migration asserts that no `cron.job` has acquired either
sweep, because the real driver is outside this database.

**The one genuinely open item.** `fn_bbj_promo_bank_check` reads whether the
swept slice arrived, and **nothing calls it** - not `cron.job`, not either repo
here, and **not the workers repo, now actually checked** rather than asserted:
it appears nowhere under `~/Documents/smarter-poker-workers`. It is a guard
with no reader (CLAUDE.md 10.86 rule 3), so a stalled sweep raises nothing on
its own; the visible symptom would be `bbj_pools.promo_balance` climbing
instead of sitting near zero. It is NOT given a scheduler here, because 10.12
forbids shipping a job as the answer and 10.85 puts scheduled work in Open Claw
rather than wherever an agent finds convenient. **Root fix:** the workers
repo's `bbj-detect` route, which already runs every five minutes and already
calls `fn_sweep_bbj_promo_all` at step 6, reads the check in the same pass and
raises on a non-zero answer. That is one edit in the repo that already owns the
schedule, and it adds no new scheduled job anywhere.
