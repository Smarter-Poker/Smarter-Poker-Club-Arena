# A Held Table Gets No Horses

**Date:** 2026-10-09

GameServer holds a cash table whose retained hand the resume door refuses from durable state: it is not rebuilt, and the door is asked again every few minutes. Nothing told the horse fleet, so it kept seating horses at tables that could not deal. On 2026-10-09 three Diamond cash tables held since 2026-10-07 (22a9bc88, 6b47e87b, 6e1b1d4e) had 17 horses seated, with 21,745 Diamonds of their buy-ins parked there; every one sat down after the hold began.

GameServer's hold now marks the table in `server/src/engine/retainedHandHolds.ts` and its release clears the mark. The fleet withholds a marked table (`retained_hand_held`) before it reads the seating policy, so no horse is sent there; the cycle after the hold is released, the table is seated normally.

The holds themselves are cleared by the companion migration that disposes a refused hand whose chairs have all closed at its resume door (see `2026-10-09-a-refused-hand-whose-seats-have-closed-frees-its-table.md`).

Law: `server/src/engine/aHeldTableGetsNoHorses.law.test.ts`.
