# 2026-08-31 - MTT Phase 6: a guarantee is a promise

Phase 6 of 7. Phases 3, 4 and 5 made money going OUT provable. This one asks
the question none of them did, and none of the estate's other checks did
either: **when a tournament advertises a guaranteed prize, does anybody verify
it was paid?**

No. Nothing, anywhere, ever asked.

## What that cost

578 completed tournaments finished under their advertised guarantee, 17,192.60
chips in total. The overlay funder itself works - it went live 2026-08-29 and
has funded 192 events for 30,202.10 chips, most recently minutes before this
was written. 566 of the 578 pre-date it.

The remaining **12 are the live leak**, and nine of them are the bad kind:

| event | field | guaranteed | pool | paid |
| ----- | ----- | ---------- | ---- | ---- |
| $100 Freeroll 12:00 PM | **326** | 100.00 | 0.00 | **0** |
| $100 Freeroll 6:00 PM | **313** | 100.00 | 0.00 | **0** |
| Early Bird Freeroll x5 | 20-48 | 75.00 | 0.00 | **0** |
| Coffee Break Freeroll x2 | 14 | 80.00 | 0.00 | **0** |
| Union Grand Championship | 62 | 2,500.00 | 1,860.00 | 1,860.00 |
| Afternoon Bounty | 23 | 200.00 | 138.00 | 138.00 |
| Late Night Grind | 7 | 50.00 | 18.90 | 18.90 |

A full field ranked, a winner stamped, and **zero chips credited to anybody**.
No alert fired from any source.

Every affected player was a horse. No human was shorted. That is luck: the
first human to win an Early Bird Freeroll gets the same nothing.

## Three defects, in causal order

### 1. The funder is never called for an event that dies young

`applyPrizeGuarantee` has exactly two triggers:

```
start()        only when late_reg_levels <= 0
level change   only when currentLevel >= late_reg_levels
```

They look exhaustive and are not. An event WITH a late-reg window that
finishes BELOW that level calls it **zero times**. Twelve of the fourteen
short events died exactly there.

`TournamentManagerBase` already promises the net for this in its own comment -
a later pass "or `fn_sweep_unfunded_guarantees`" re-drives it. That function
was never written. The name appears nowhere else in the repo, and
`pg_get_functiondef` returns nothing for it in production. There was no retry,
no sweep, no cron. If none of the two triggers fired, the guarantee was never
funded, ever.

**Fixed** by funding on the finish path, at the last moment before the money is
priced, and re-reading the pool afterwards so the prices use the funded figure.
Deliberately not gated on `prize_pool > 0` or `buy_in_amount` - those two
conditions are precisely what made a freeroll invisible everywhere else. The
RPC returns early on `finalized` and settles to `greatest(pool, guarantee)`, so
a re-drive moves nothing.

### 2. Paying nothing was silent

```ts
if (winnerPrize > 0) { /* ...credit, retries, and EVERY alert... */ }
```

The alerting added on 2026-08-31 - `winner_prize_credit_failed`,
`prize_credit_failed` - lives **inside** that block. It can only escalate a
credit that was attempted and failed. A credit never attempted said nothing.

With a pool of 0 every price is 0, the block is skipped, and 326 players get a
champion and no money in total silence.

**Fixed**: zero now raises `Tournament.winner_paid_nothing` - `critical` when a
guarantee was advertised, `warning` when the event genuinely had no pool. It
never blocks the finish.

### 3. No detector could see it

Phase 2 built `poker_tournaments_unpaid_completed` for exactly this shape:
"non-zero prize pool and zero prize payments recorded. Players bought in and
nobody was paid." Its WHERE clause carries

```sql
AND COALESCE(t.prize_pool, 0) > 0
```

A freeroll's pool is 0 by construction, so **the detector is filtered out by
the exact column the defect zeroes.** The alert rule built on it could never
fire on any of the nine.

Every other guarantee check misses too, and each for its own reason:

| check | why it cannot see this |
| ----- | ---------------------- |
| `trg_tournaments_guarantee_affordable` | scoped to ANNOUNCED/REGISTERING/RUNNING; pre-commitment only |
| `fn_overlay_at_risk` | `buy_in_amount > 0` - excludes every freeroll - and not COMPLETED |
| `fn_audit_overlays` | same `buy_in_amount > 0`; measures overlay at start, never whether it was funded |
| `fn_backpay_hu_winner_shortfalls` | `guaranteed_prize = 0` - explicitly excludes guaranteed events |
| `fn_tournament_conservation_delta` | never reads `guaranteed_prize`; for a freeroll every term is 0, so it reads perfectly conserved |

The nine sat in a genuine blind spot: conservation-clean, affordability-clean,
and below the `prize_pool > 0` floor of the one detector built to catch them.

**Fixed**: `fn_tournament_guarantee_check(p_hours)`, wired into the same
six-hourly sweep as the rake, satellite and disbursement audits. It measures
what was **paid**, from `tournament_payouts` - the Phase 3 record - not from a
column an outage can overwrite. One alert per event, ever.

## Proven, not asserted

The funder was probed against the real 313-player freeroll inside a rolled-back
transaction, per `CLAUDE.md` 11.5:

```
BEFORE  prize_pool 0.00   prize_pool_finalized false
        fn_apply_prize_guarantee(..., 'finish_fallback')
AFTER   prize_pool 100.00 prize_pool_finalized true
ROLLBACK
verified after rollback: 0.00 / false / 0 overlay rows
```

So the finish-path fix turns "313 players, winner paid 0" into a funded 100.00
pool priced through the normal structure.

The detector, live:

```
run 1  checked 94  short 4  paid_nothing 2  chips_short 852.00  alerts 4
run 2  checked 94  short 4  paid_nothing 2  chips_short 852.00  alerts 0
```

Idempotent: the second run raised nothing and the alert count stayed at 4.

## Deliberately not done

**The 566-event, 15,724.50-chip historical backlog is not back-paid here.**
Those events pre-date the funder, they are settled, and paying them is an
owner's decision about money, not a sweep's. The detector's window is bounded
so it reports the present rather than manufacturing 566 criticals.

## Adjacent finding, reported not fixed

Two of the nine freerolls ranked 313 and 326 players at `current_level = 0`,
inside 90 seconds, with no hand ever dealt. The elimination sweep runs 5s after
start and reads uncredited seat stacks as busts. Its two guards both miss:
`bustingArmedAt` is only ever assigned on the Spin reveal path, so it is 0
forever for an MTT, and the zero-chip refusal only triggers when EVERY live
player reads zero - one credited stack lets the whole field be eliminated.

It is intermittent: 4 events in 7 days, none in the last two days. It touches
the elimination sweep, so it wants its own change and its own evidence rather
than a rider on this one.

## Tests

`aGuaranteeIsAPromise.law.test.ts` - 12 pins, including that funding happens
BEFORE the winner prize is priced, that the pool is re-read rather than trusted
from the stale snapshot, that the fallback is not gated on `prize_pool` or
`buy_in_amount`, that the zero alert sits OUTSIDE the `winnerPrize > 0` block,
and that the audit path calls neither `fn_credit_and_log` nor the funder - it
detects and never repairs.

3373/3373 server tests green.
