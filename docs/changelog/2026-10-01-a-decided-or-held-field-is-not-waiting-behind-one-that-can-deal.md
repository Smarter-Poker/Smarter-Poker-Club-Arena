# A Decided Or Held Field Is Not Waiting Behind One That Can Deal (2026-10-01)

## What Production Showed

Engine 84131f2d, 19:00-20:10 UTC: 625 managers registered with the elimination
scheduler, 577 queued, oldest waiter 280 s, mean sweep 2.4 s over four slots.

- Midday Free Buy 32375574: last bust 19:32:22, winner paid 19:52:14.
- DSS $100 Turbo Freeroll 9fee5704: last bust 19:37:29, completed 20:07:19. Its
  manager diagnostic showed no sweep admitted from 19:37:29 to 19:54:00 although
  the decided-but-RUNNING board woke it every ~70 s.
- Cohort satellites c2a1ece4 (one survivor) and bd973d49 (two players, one seat)
  and d9cc8159 (eight players) were parked on a held qualifier boundary for
  30 to 90+ minutes. Adoption and every zombie rebuild hold the boundary; the
  sweep that releases it waited behind the whole platform.

## The Rule

A field that cannot deal is served from the consolidation lane
(see 2026-09-29, `aFieldThatCannotDealIsNotWaitingBehindOneThatCan`). Two more
fields qualify:

1. A decided field: the `stalled_decided_survivor` wake moves the manager to the
   lane before it is queued, so the finish stage pays the winner within seconds.
2. A held satellite qualifier boundary: holding it moves the manager to the lane,
   a fresh scheduler registration re-declares it, and a clean balance pass keeps
   the lane while the boundary is still held.

Law: `server/src/tournament/aDecidedOrHeldFieldIsNotWaitingBehindOneThatCanDeal.law.test.ts`.
