# The spin start read its own roster twice

2026-08-31, spins audit part 4.

## The measurement came first, on purpose

`tournaments.spin_reveal_lag_ms` landed earlier today, and it is the first
time the platform has stored the number Dan's rule is written in terms of —
the gap between the third paid seat and the wheel going out. Live, from the
engine, first 220 spins:

| hour UTC | spins | p50     | p90     | p99      | worst    |
| -------- | ----- | ------- | ------- | -------- | -------- |
| 17:00    | 74    | 2,398ms | 9,076ms | 15,524ms | 16,542ms |
| 18:00    | 146   | 4,720ms | 9,131ms | 11,291ms | 11,709ms |

`past_the_lead_in` — spins that missed _"the animation must start 1 second
later"_ outright — is **208 of 220 (95%)**. The anchor fix shipped an hour
earlier is doing its job: 12 spins kept their third-payment anchor, which was
structurally impossible before it. The rest are genuinely late.

## Where the time was NOT going

Two theories, both tested against production and both wrong, recorded so the
next person does not spend the afternoon on them:

- **"Seats fill before the payments land, so `start()` stands down and
  retries."** Measured: third seat to third `tournament_buyin` debit is
  **p50 0.00s, p90 0.00s** across all 220 spins. The registration RPC writes
  the seat and the debit in one transaction. There is no gap to churn in.
- **"The fast lane's board read is the bottleneck."** `EXPLAIN ANALYZE` puts
  it at ~90–305ms, and the per-game 12-second throttle on
  `fillPartialSeatFirstGame` is intact, so the lane is not saturating itself.

## What it is

Five sequential round trips sit between `start()` and the draw, and **two of
them were the same query**: a head count of `tournament_players` for this
tournament with status in `('registered','playing')`, then — thirty lines
later — the paid-entry roster of exactly those rows.

A Spin holds three players. The rows _are_ the count.

The head count is now the roster read for a Spin with a buy-in, and the paid
gate consumes what it returned. One round trip leaves the critical path.

**Only for a Spin with a buy-in**, which is precisely where the paid gate was
going to read those rows anyway. An MTT keeps its head count — reading 390
player rows to learn there are 390 is the same trade made backwards.

## The failure policy moved with the read

The paid gate's read is load-bearing. `THE GATE MUST NOT DISABLE ITSELF ON A
FAILED READ (2026-08-28)` records why: on a failed read `regs` is null, so
`regIds` is empty, the debits query falls to its sentinel UUID, `unpaid` is
empty, and **the gate passes having verified zero payments** — reopening the
free-spin incident of 2026-08-20.

So the stand-down moved with the read: an unreadable roster reports
`Tournament.spin_paid_roster_unreadable` and stands the start down, before
the gate is reached. `blockAfter(BASE_CODE, 'if (rosterErr)')` pins that it
still does.

## Honest scope

This removes one round trip of five. It is not the whole 4.2 seconds and this
changelog does not claim it is — what it claims is that the path is now
measured, two plausible causes are eliminated with numbers, and the one
provably free read is gone. The remaining four are a paid-entry check that
genuinely cannot be parallelised (the debits query filters on ids the roster
read returns), the reserve-ledger read that could be, and the two reads the
fast lane makes before it ever calls `start()`.

## Verification

- server tournament suite: **41 files, 527 tests, green**
- `npx tsc --noEmit -p server/tsconfig.json`: clean
- four new pins in `SpinStartsInOneSecondAndPlaysInFull.test.ts`, including
  one asserting the stand-down survived the hoist
