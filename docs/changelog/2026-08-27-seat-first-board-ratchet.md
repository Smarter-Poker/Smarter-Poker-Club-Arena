# The held-empty hold was a life sentence, and it killed the whole seat-first board

**Date:** 2026-08-27

## What happened

At 00:56 UTC a rule shipped that holds a share of seat-first games empty so a human
has somewhere to start a game — Dan, 2026-08-26: _"LEAVE ... 33% OF ALL SPINS AND 50%
OF HEADS UP [EMPTY]."_ The intent is right. The implementation hashed the tournament
id **alone**, so a board that rolled held-empty was held empty **forever**.

On its own that is a stalled game. Combined with how the board keeper decides what to
open, it killed the product:

1. `ensureBoardOpen` treats any joinable REGISTERING instance as **covering** its price
   point, and opens no replacement while one exists.
2. A held-empty instance never fills, so it never starts, so it never leaves REGISTERING.
3. Its price point is therefore covered by a husk, permanently.
4. A NOT-held instance fills, starts, completes, and is replaced by a fresh instance
   that **re-rolls** the hold.

Every price point keeps re-rolling until it draws "held", then it is stuck. An absorbing
Markov chain whose absorbing state is a dead game. With ~300 Spins completing an hour,
all 48 price points absorbed within about two hours.

## Measured on production, ~20 hours later

|                        | before (08-26) | after (08-27) |
| ---------------------- | -------------- | ------------- |
| Spin starts / hour     | ~300           | **1**         |
| Heads-Up starts / hour | ~150           | **0**         |

- 33 Spin + 16 Heads-Up boards sat in REGISTERING; 49 of 49 evaluated held-empty.
- The survivors were **90% under the 33 threshold and 100% under 50** — the board had
  become a sieve retaining precisely the held-empty rolls.
- The hash is **not** skewed: 2,000 random uuids gave 33%/50%, and the last 1,000
  COMPLETED seat-first games gave 30%/47%. This was survivorship, not bias.
- Last Spin hand 12:08 UTC, last Heads-Up hand 01:50 UTC.

Ruled out along the way, each with a measurement rather than a reading: `cashRoomReserve`
(reserved = 0; 45 cash tables, 273 seated against a floor of 90), fleet exhaustion (223
horses completely idle, max load 5), lane skew (192 cash / 192 events / 200 both), the
roster-full 23514 deadlock (roster == live seats on every board), and the DB path itself —
`fn_seat_horse_in_seat_first_game` was probed live inside a transaction that was rolled
back and returned `{"ok": true, "seat_number": 3, "seats_taken": 3}` on the very board
that had been stuck for twenty hours.

## The fix

**1. The hold rotates.** It is now bucketed in time, exactly like its sibling
`cashTableHeldEmpty`, which was written correctly and rotates every 2h. A board held in
one bucket is fillable in the next, so a price point cannot ossify, while at any instant
the requested share of the board is still genuinely empty. The bucket is 30 minutes, not
the cash room's 2 hours, because a cash table is long-lived while a Spin instance lives
minutes — a 2h hold outlives many whole games, which is exactly how one roll ossified a
price point for a day.

**2. The bucket is mixed properly.** `horseHash` is a weak multiply-add and this codebase
already records twice that a low-bit modulo of it clusters on structured input.
Consecutive bucket numbers are the most structured input there is, so the naive
`${id}:hold-empty:${bucket}` left neighbouring buckets **correlated** — the first draft
of this fix had a board held for 8 straight buckets (four hours), caught by the test
below. The bucket is now spread by a golden-ratio constant and run through the murmur3
finalizer, so every output bit depends on every input bit.

**3. The hold never strands a board that already has players.** The gate now applies only
when `liveCount === 0`. It used to apply at any occupancy, which created a second class of
permanently stuck game: a board that opened NOT held (two horses seated, one seat to go)
and then had the hold roll on later was refused its final horse forever, sitting at 2/3 —
visibly alive, impossible to start, and covering its price point the whole time. Six Spins
and five Heads-Up games were in exactly that state. The rule is "leave some boards empty",
not "strand boards half-full".

This also deletes two queries per skipped board per pass: the `humanSeated` probe was
guarded on `liveCount > 0`, which the new condition excludes, so it could never once have
returned true.

**4. It can never be silent again.** Every refusal on this path returns 0 — the held-empty
gate returned 0 silently and `pickFreeHorses` returns `[]` silently — and `Filled "..."`
only logs when something was added. So a board adding nobody forever was exactly as quiet
as a board with nothing to do. A throttled count of _distinct_ boards skipped now reports
once every 10 minutes.

## Effect on the 49 real stuck boards

|                     | held now             | fill immediately |
| ------------------- | -------------------- | ---------------- |
| old rule            | **49 / 49, forever** | 0                |
| new rule, bucket +0 | 20 / 49 (41%)        | **29**           |
| +30m                | 13 (27%)             | 36               |
| +60m                | 22 (45%)             | 27               |
| +90m                | 15 (31%)             | 34               |

Boards still stuck after 24 hours under the new rule: **0**.

## Tests

`server/src/services/seatFirstHoldRotates.test.ts` — 8 tests:
the share held is still ~33% / ~50% at any instant; **every** board becomes fillable
within a day; no board is held for 12 consecutive buckets (a 1-in-a-million event at a
1-in-3 hold, so it cannot flake, but any latching fails it); the verdict is stable _within_
a bucket so a board does not flicker; the seat-first bucket is shorter than the cash-room
bucket; the gate is guarded on `liveCount === 0`; and a skipped board is reported.

Full suites: **7,401 client / 1,975 server passing**, server tsc clean.
