# The chase that never caught up, and the lock order that let go

2026-08-31, spins audit part 3.

## 1. The chase was the one beat that did not join the shared moment

A spin reveal is a SHARED moment. The engine names an instant, every seat
animates against it, and a client that loads slowly or refreshes picks the
wheel up where everyone else already is:

```ts
const elapsed = Math.max(0, Date.now() - data.revealAtMs);
const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
```

Every phase in `SpinWheel` is scheduled through `at()` — lead-in, countdown,
chase, result, fade. **Except the chase's own light steps**, which were
scheduled at their raw offsets:

```ts
schedule.forEach((offset, stepIdx) =>
  timers.push(setTimeout(() => setLitIndex(stepIdx % order.length), offset))
);
```

so they always replayed from step one over the full `chaseMs`.

A client that joined two seconds into a six-second chase therefore got the
result card at the _correct_ instant — `at()` handled that — while the runner
was still walking from the beginning. Its remaining `setLitIndex` calls then
ran on top of `setLitIndex(targetIndex)` for the rest of the chase.

**The light lands on the winner, walks off it, and keeps going.** On a table
where three seats are meant to be watching the same disc, the one player who
reloaded watches it stop somewhere else. The ticking had the same shape —
`playSpinTicking` was handed the full schedule, so pegs kept striking after
the prize was announced.

### The fix

`chaseCatchUp(schedule, elapsedIntoChase)` is a pure function beside
`chaseSchedule`. It drops the steps already behind us, reports the last of
them so the disc can be lit where the runner actually IS rather than blank,
and rebases the rest. Both the light and the ticking now take the caught-up
schedule.

`tests/unit/spinChaseCatchUp.test.ts` executes it on real numbers, including
the regression itself:

> with 2s of a 6s chase gone, the raw schedule's final step is 6s away — a
> full 2s past the moment the result card is due. After the fix, no step on
> any join time can outlive the result.

## 2. Attribution was taking its locks in whatever order it felt like

`fn_attribute_tournament_rake` loops over the players who generated a
tournament's rake and writes three rows per player, all keyed on the USER:
`vip_points_carry`, `agent_commissions`, `player_stats`. Two settlements that
share a player contend for the same rows — and the driving query had **no
`ORDER BY`**, so each took its locks in whatever order the hash aggregate
produced.

Two transactions taking the same locks in different orders is the textbook
deadlock, and production says so plainly: `deadlock detected` is the _only_
attribution error recorded in the last 24 hours, and 18 fired in one afternoon
while the back-pay replayed history alongside live traffic. This platform is
horse-heavy and a horse plays many tournaments, so overlapping player sets are
the normal case, not the unlucky one.

`ORDER BY x.uid` is the whole fix. Nothing about what is credited changes —
the loop body, the amounts and the idempotency keys are untouched — but
concurrent settlements now queue instead of colliding.

It was never a money loss: the settle path leaves a failed row unstamped and
the 15-minute repair drains it, which is what happened to today's single
occurrence (23.00 chips on _Afternoon Bounty_, repaired on the next pass).
This removes the failure rather than relying on the recovery, and it is what
makes a large replay safe to run at volume — which now matters, because
`fn_backpay_tournament_rake_attribution` exists to do exactly that.

## 3. Reported, deliberately not repaired: 293 chips of pool overstatement

`v_spin_draw_booking_gaps` holds **11 spins** in which the reserve pool booked
LESS than the players were actually paid. The shape is exact — the ledger
booked one multiplier step below the one that was paid:

| tournament        | buy-in | row multiplier | pool drew   | players credited | short      |
| ----------------- | ------ | -------------- | ----------- | ---------------- | ---------- |
| 5 Chip Spin NLH   | 5      | 3x             | 10.00 (2x)  | 15.00            | 5.00       |
| 50 Chip Spin PLO6 | 50     | 5x             | 150.00 (3x) | 250.00           | 100.00     |
| … 9 more          |        |                |             |                  |            |
| **total**         |        |                |             |                  | **293.00** |

Cause: a settle that ran before the row write, answered `already_settled` on
the retry, and booked the earlier multiplier while the payout used the later
one. The engine now adopts the booked multiplier on that path — and the
evidence agrees it is fixed: **every one of the 11 is from 2026-08-22 to
2026-08-24, and none has occurred in the seven days since.**

So this is a detector that works, a cause that is closed, and a residue nobody
has repaid. `spin_bonus_pools.balance` for the union pool is overstated by
293.00 chips: the chips left the platform to players, they were simply never
deducted from the pool.

**Not repaired here, on purpose.** Moving 293 chips out of an operator pool is
a remediation decision, not a bookkeeping correction, and this repo has
precedent for leaving exactly that to Dan — `spinSpec` records the same choice
about the 36,723.84 chips the retired rake bands left behind. The number and
its cause are written down so the decision can be made rather than discovered.

## Verification

- `tests/unit/spinChaseCatchUp.test.ts` — 13 tests
- existing spin client suites re-run — 109 tests across 6 files, all green
- `npx tsc --noEmit` — clean
- migration applied to production and probed in a rolled-back transaction
  (CLAUDE.md 11.5): 3 members, 3 users, 4.80 chips, behaviour unchanged
- `v_tournament_rake_attribution_gaps` and the repair queue are both empty
