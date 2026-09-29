# The blind clock burned past its witness, not past its lease

**2026-09-23** - finishing the settlement of the frozen tournaments, and
closing the two populations that the first repair's derivation excluded.

## What this is

[#5140](https://github.com/Smarter-Poker/club-arena/pull/5140) fixed the cause:
`advanceBlindLevel` no longer spends a blind level on a hand that was never
dealt, in the same shape as the break guard and the maintenance-freeze guard
beside it. It shipped with a migration,
`20260923165845_restore_blind_levels_burned_by_a_stalled_tournament_clock.sql`,
that put twelve stalled events back to the level in force at their last dealt
hand.

Two things were left undone when that work stopped.

1. **The migration had never been applied.** It merged to `main` and the
   database had never seen it. Applied here at **2026-09-23 20:40:14 UTC**,
   recorded as `20260923204014`, and matched to its repo file by name (the
   recorded-migrations check indexes by name as well as by version stamp, so
   the differing stamp is not drift). Its own `@live-proof` now returns true.
   Twelve events restored; no level raised; no money moved.

2. **Its derivation asked a narrower question than the defect**, and excluded
   two further populations _by a JOIN rather than by a test_, so neither was
   counted, reported, or repaired. That is what this changelog is about.

## The two populations it missed

### A. A manager that is still heartbeating - 56 events, 539 seats

The first derivation opened with

> no tournament manager has renewed its lease for an hour. That is the
> population whose clock ran unattended.

A lease heartbeat is not evidence that the game was being **played**. It is
evidence that a manager process is alive - and the manager process is exactly
the thing that burns the levels. Fifty-six RUNNING events have a lease renewed
inside the last hour, tables that have dealt nothing for up to **127 hours**,
and blinds standing above the level of their own last dealt hand.

CLAUDE.md 10.9 says prefer the witness that was there. The witness is the hand
in `hand_history`; the heartbeat is not a witness to anything. So the
derivation here drops the lease condition entirely and asks only what the hands
say.

The worst of them:

| event                        | id         | seats | level    | big blind        | stack, in BB    |
| ---------------------------- | ---------- | ----- | -------- | ---------------- | --------------- |
| 100 Chip Deep Stack Spin NLH | `64609b68` | 3     | 88 -> 3  | 10,000,000 -> 60 | 0.0001 -> 16.67 |
| 50 Chip Deep Stack Spin PLO5 | `0147ba18` | 2     | 131 -> 1 | 10,000,000 -> 30 | 0.0002 -> 50.00 |
| 1 Chip Spin PLO5             | `18775071` | 2     | 7 -> 6   | 150 -> 120       | 3.00 -> 3.75    |

Across all 56: 3,085,500 chips on 539 seats, average stack **36.4 BB before,
51.2 BB restored**, worst case 0.0001 BB.

### B. An event that never dealt a hand at all - 2 events, 5 seats

The first derivation reached each tournament's ladder through an INNER JOIN on
its last dealt hand. An event with no hand has no such row, so it left the set
silently. Two had run their clock clean off the end of their own published
**twelve-row** ladder:

- **3 Chip Deep Stack Spin PLO4** `e9c07fe8` - started 09-18 05:55, table still
  `waiting`, never dealt a card, **level 1709 of 12**, blinds
  10,000,000/10,000,000 against three seats holding 1,000 each: **0.0001 big
  blinds** apiece.
- **PLO4 Heads-Up 10** `114c6069` - started 09-22 23:44, never dealt,
  **level 354 of 12**. Its anchor was 20:41 UTC, three minutes before this was
  written; by the time the probe ran ten minutes later it had reached **357**.
  This one was still burning while the first repair was being applied.

For these the witness is not a hand but the absence of one: no hand was dealt,
so no level was ever legitimately spent. Level is the first row of the ladder,
anchor is the recorded start. Nothing is extrapolated.

The already-merged guard covers both populations without further engine work:
its witness `lastObservedHandCompletedAtMs` is **seeded to zero**, so an event
that has never dealt holds its level for ever rather than spending it.

## The settlement: nothing was owed, and nothing moved

Read from rows on 2026-09-23, across all **399** stalled RUNNING events holding
seats:

|                                    |                            |
| ---------------------------------- | -------------------------- |
| `tournament_escrow` gross_in       | 42,141.00                  |
| prize_out / fee_out / refund_prize | 0.00 / 0.00 / 0.00         |
| prize_balance                      | 75,701.35                  |
| escrows closed                     | 0 (of 424, all `enforced`) |
| `fn_unaccounted_seat_exits()`      | 0 rows                     |

Nothing has been paid out, so nobody has been short-paid. Nothing has been
refunded, so nobody has had an entry taken and returned at the wrong price. No
escrow is closed, so no event has been settled against a wrong board. No stack
left a seat without a matching wallet credit.

**Twenty-five events took entry money and never dealt a hand** (gross_in
1,640.00, prize_balance 1,620.10, earliest start 09-18 05:55). That is money in
for a service not yet delivered - but it is _held_, not lost, and it is not
owed back while the event is still live and recoverable. The correct outcome
for them is to **deal**, not to refund: cancelling twenty-five live events out
from under an in-flight engine recovery would destroy a tournament its entrants
still hold a seat in, and 10.9 requires the outcome be read rather than
assumed. Their money is proven intact above; what they need is the engine.

**The money path itself is healthy**, which is what makes "resume" the right
call rather than a hopeful one. In the last 24 hours: 12,456 tournament seat
exits (34 in the last hour), 4,354 payouts, 4,191 tournaments COMPLETED, and
**zero** COMPLETED events with an unclosed escrow still holding a prize
balance. Players can leave a seat today and finished events do pay.

**Every one of the 3,147 seats across the stalled population is a horse; zero
are human.** CLAUDE.md 10.5 is why that narrows nothing - a horse pays the same
buy-in out of the same club wallet and is owed the same game - and no
`is_horse` filter appears anywhere in this work. It is recorded only because a
reader is entitled to know that no human is presently waiting on a payment.

## What is not fixed here

The engine is still on `8825af51817f379c4261658ca29ecc9d8d81932d`, five days
stale, and reports `f06_preparation_unresolved` with 65 dead-stalled tables.
**The blind guard from #5140 is merged but not deployed**, so until that release
lands the clock can burn these levels again - `114c6069` climbed three levels
during this session. Restoring the levels is worth doing now regardless,
because it is what a resuming engine will resume _from_, and because it can
only ever lower a blind.

The engine recovery itself is owned by another agent (F06 / lease root fix) and
is deliberately untouched here, as is `Morning Free Buy (NLH)`
`7c6277e7-921d-4651-91bc-15071a3884be`, owned by a third.

## Why this is not a band-aid (10.11, 10.12)

No job, cron, sweep, backfill, healer or reconciler is created. The cause is
already fixed in code and pinned by
`tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts`.
This is a one-time correction of rows a defect wrote, applied beside that fix,
and it is idempotent by construction: a restored event has `level_started_at`
equal to its last hand's instant, so the `level_started_at > dealt_at` test is
false for it on any later run. The twelve already restored are excluded by that
test, not by a hard-coded list.

The migration asserts its own premise and aborts rather than guess: it refuses
an empty derivation, a count far above what was measured, an ambiguous ladder
match, any row that would not move **down**, and any derived level that would
fall outside its own published ladder. Proved first in a rolled-back
transaction per 11.5 - `PROBE OK a=56 b=2 total=58 amb=0 raised=0 updated=58
alerts=1`.

## Files

- `supabase/migrations/20260923204615_restore_blind_levels_the_clock_burned_with_a_live_lease_and_.sql`
- `docs/changelog/2026-09-23-the-blind-clock-burned-past-its-witness-not-past-its-lease.md`
