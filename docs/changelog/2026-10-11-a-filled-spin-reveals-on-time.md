# A Filled Spin Reveals On Time

Date: 2026-10-11 (UTC)

## The Rule

Dan, approved 2026-10-09: the Spin wheel opens two seconds after the last seat is paid (SPIN_REVEAL.LEAD_IN_MS = 2000).

## What Was Measured

Outside the hourly break, from 11:00 to 19:50 UTC on 2026-10-11, between 15 and 25 percent of Spins still reached the reveal after that instant (p90 lag 335 to 654 ms, worst 5.4 s). The engine log for 19:00 to 19:50 UTC split the 159 late Spins of 592 by cause:

- 59 (of 61 such boards): the walk's past-start top-up and the fast lane's fill worked the same board at once. One bought the last seat and asked for the start; the door refused it because the other top-up was still in flight, and forgot the ask. The other spent about 1.5 s finding the table full, and the board then waited for the next fast-lane poll. Start came 1.7 s after the fill at p50.
- 71 (of 237): the walk's own top-up bought the last seat, and nothing asked for the start until the next fast-lane poll (0.77 s at p50).
- About 30: the seat purchase itself or the start work ran long on the database (the payment row is stamped when its transaction begins, and some seat calls took 1 to 3 s to return).

The start work itself, from "Starting" to the reveal broadcast, was steady at 0.82 s p50 and 1.03 s p90 in every group, so it was never the cause on its own: the late Spins were found late.

Post-break minutes (03 to 07) ran 25 percent late against 19 percent for the rest of the hour, so the surge is a small factor, not the cause.

## The Fix

- One lane fills a seat-first board at a time. The fast lane's fill now holds the same in-flight claim the walk's top-up holds, and each leaves a board the other is filling.
- A start refused because a top-up is in flight is kept, and runs the moment that top-up settles, through the same front door and every gate it keeps (current generation, no freeze, no parked launch, no admitted manager).
- The walk's past-start top-up that completes a seat-first board asks for its start itself, exactly as the fast lane's fill does.

## Pinned By

server/src/aFilledSpinStartsAtOnce.law.test.ts (runtime tests of the kept start and its gates, plus source pins on the one-filler claim and the walk's start).
