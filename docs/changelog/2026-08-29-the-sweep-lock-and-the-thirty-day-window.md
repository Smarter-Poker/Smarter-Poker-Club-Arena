# 2026-08-29 — a lock with no way out, and a window that was hiding money

Two findings, unrelated in cause and identical in shape: something that could
only fail silently, and nothing watching it.

---

## 1. The elimination sweep lock could be held forever

`TournamentManagerEliminations.startEliminationChecker` opens with

```ts
if (!this.running || this.isProcessingEliminations) return;
this.isProcessingEliminations = true;
try {
  /* the sweep */
} finally {
  this.isProcessingEliminations = false;
}
```

The `finally` looks like a guarantee and is not. `finally` runs when the try
block **settles**, and an await that never settles never settles. One
PostgREST request that hangs rather than erroring — a dead socket the runtime
has not noticed, a gateway holding the connection open — takes this lock for
the life of the process.

What that costs is not a slow tournament, it is a dead one. Every later tick
returns at the first line, so nobody is eliminated, `remainingCount` never
falls to 1, `finishTournament` is unreachable, and the whole field's prize
money is stranded — the champion's included. That is precisely the outcome of
the 2026-08-28 ladder deadlock (Union PKO Afternoon 4f42d847), arrived at by a
different road. There was no timeout and no alert, so it would have been
equally silent: 4f42d847 sat for over an hour and was found by a player.

### What is there now

A held lock is inspected rather than obeyed. `eliminationLockVerdict` — pure,
in a deliberately import-free module so it can be pinned by unit test rather
than scanned for with a regex — answers one of three ways:

| held for   | verdict | what happens                                                |
| ---------- | ------- | ----------------------------------------------------------- |
| < 60s      | `wait`  | normal; most ticks of a busy tournament                     |
| 60s – 5min | `warn`  | one report per episode, and keep waiting                    |
| >= 5 min   | `force` | take the lock back and start a fresh sweep on the same tick |

The asymmetry is the point. Complaining is free; forcing is not, so a merely
slow sweep gets four more minutes to finish on its own. The alert is
rate-limited by `eliminationSweepStuckReportedAt < eliminationSweepStartedAt`
— at a 5-second interval an unlimited alert would be 720 reports an hour for
one tournament, which is how a channel stops being read.

### Forcing is made safe by a generation, not by hope

Two live sweeps are a collision generator: the ladder takes finishing places
from the set that is **free at the moment it reads**, and `takenPositions` is a
snapshot. A superseded sweep that woke up and carried on would hand out a place
the live sweep may already have paid — and the wallet key
`tourney:{id}:prize:{user}:{place}` dedupes a repeated USER, not a repeated
PLACE, so nothing downstream would catch it.

So each sweep carries the generation it was born with:

- inside the elimination loop, **before** any write, a superseded sweep stands
  down and says so (`Tournament.elimination_sweep_superseded`). Every player
  still in its list has 0 chips and is picked up by the sweep that replaced it.
- in `finally`, only the current holder releases the lock. A stuck-then-settled
  sweep must not free a lock the live sweep is holding; that would let a third
  sweep start alongside the second.

The residual risk — one mislabelled place — is accepted for the same reason the
2026-08-28 ladder fix accepts it: a mislabelled place is a bookkeeping error a
human can renumber, and refusing to eliminate anybody strands the entire
field's money.

`server/src/tournament/EliminationSweepLock.guard.test.ts`, 12 tests. Full
server suite green: 212 files, 2,320 tests.

---

## 2. 11,238.80 of prize money the thirty-day window never asked about

On 2026-08-28 a sweep paid 20,110.50 of prize money that players had earned and
never been given, across 75 events, and then reported _owed across all completed
events: 0.00_.

That report was bounded by `started_at > now() - interval '30 days'`, and the
bound is the whole story. 938 completed events sit outside it. Asking them:

- **38 events, 11,238.80 owed**, none newer than 2026-08-04.

Same root cause as yesterday's, and verified against the **ledger** rather than
taken from the reconciler — which had a counting bug of its own as recently as
yesterday (`20260828_reconcile_counts_a_debit_as_a_debit`). Union Grand
Championship (NLH) `3b1a6dc9`, pool 2,500.00:

| place | `tournament_players.prize` | wallet rows                        |
| ----- | -------------------------- | ---------------------------------- |
| 1     | 750.00                     | 750.00, dated the day of the event |
| 2–9   | 0.00                       | none at all                        |

All eight of the unpaid places share one identical backfill `eliminated_at` of
`2026-08-28 03:12:31.611729` — a month after the event ended on 2026-07-31.
The reconciler's expected payouts for that event sum to exactly 2,500.00.

Paid through `fn_tournament_payout_reconcile(id, true)`, the sanctioned
idempotent path, each event dry-run first and asserted to 0 owed afterwards:
`20260829_pay_prize_money_outside_the_thirty_day_window`. Horses paid on
identical terms — `is_horse` is not read anywhere in it (CLAUDE.md 10.5).

Post-check on `3b1a6dc9`: places 1–9 now hold 750 + 500 + 375 + 250 + 200 + 150

- 125 + 87.50 + 62.50 = **2,500.00**, the pool to the cent.

### Two things this leaves behind, deliberately

**Dan declined a recurring all-history check** (2026-08-29). The window that hid
these is unchanged. Anyone finding this note later should know it was asked and
answered, not overlooked.

**`tournament_players.prize` is still 0.00 on the repaired places.** The
reconciler credits the wallet and does not restate the row, so standings show
0.00 for a place that was in fact paid. Cosmetic, but it is the number a player
looks at. Not fixed here; it also applies to yesterday's 337 payments.

---

## 3. The alerts, and the ruling behind closing them

`fn_tournament_payout_reconcile` files a `critical` financial alert for every
issue list it produces and **nothing has ever closed one** — 206 were closed by
hand yesterday, 77 stood open this morning, and roughly a dozen of those were
filed by the dry runs used to investigate them. A dry run should not raise a
critical alert; that alone is worth fixing.

Dan, asked what to do about the residue: **leave the money, close the alerts.**
The reconciler deliberately never claws back automatically, so an `overpaid`
line is a report rather than a task, and a `no_finisher_recorded` place is owed
to nobody identifiable. Neither changes on its own, and leaving them open only
buries the next real one.

`20260829_close_payout_alerts_dan_accepted_the_overpayments` re-asks the live
reconciler for every open alert and resolves **only** those now showing
`total_top_up = 0`, stamping the ruling into the row. Anything still owing a
cent stays open and loud — which is exactly how the 11,238.80 above was found.
All 77 closed; 0 open.

---

## 4. A diagnostic that cries wolf

The handoff's "is any tournament deadlocked right now? — expect 0" query counts
players with `status='playing'` and `chips <= 0` in a RUNNING event. On a large
rebuy event that number is legitimately enormous.

Measured this morning on `$100 Freeroll • 6:00 AM` (355 entrants, 40 tables):
132 players at 0 chips, unplaced, 82 minutes in, and nothing wrong. The event
runs unlimited rebuys through level 6 plus an add-on period, so busted players
correctly pile up until the window shuts and then flush in batches. The same
event's four previous runs recorded their first elimination at 67, 69, 70 and
74 minutes — every one of them at the moment the rebuy window closed. Today's
flushed at 83 and finished with a textbook ladder.

Roughly forty minutes went into confirming a healthy tournament was healthy.
The query needs to ask _how long_ a player has been sitting at zero, and
whether the rebuy window is even shut, before it calls anything a deadlock.
