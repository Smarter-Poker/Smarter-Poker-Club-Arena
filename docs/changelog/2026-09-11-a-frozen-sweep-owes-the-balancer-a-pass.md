# A frozen sweep owes the balancer a pass after the thaw

2026-09-11

The 2026-09-10 fix (#4184) taught the balancer to see tables that hold one
player. The same events stayed frozen anyway, because the balancer was never
asked outside a maintenance freeze.

## What was measured

Production, 2026-09-11 11:50 UTC: **57 RUNNING events** (402 funded players,
17,572.20 in prize pools) in which every live table held exactly one funded
player and no table held two. They could not deal. The oldest (Midweek Bounty 5e1f17e4) had not dealt since 2026-09-10
06:40; the $100 Freeroll 2dbc9bb6 named in the 2026-09-10 changelog was still
35 players on 35 tables. Seven of them hold paid-range standings that are out
of true bust order (see the sweep report) - none of their prizes is paid yet.

Every one of them logged the same three lines after the 10:55 deploy and
nothing else but its blind clock (7d6f3d3b was at level 102 of a 40-level
structure):

```
10:56:15 [Tournament:7d6f3d3b] Resumed DURING a break - re-pausing for the remaining 225s
10:56:15 [Tournament:7d6f3d3b] Resumed - 43 tables, level 98
11:00:03 [Tournament:7d6f3d3b] BREAK ENDED - resuming play
```

## Why

- An event whose tables cannot deal produces no hand, no bust and no wake. The
  only elimination sweep it gets is the one its manager requests at adoption
  (`engine.resume`, #4149).
- Adoption follows an engine restart, and the restart is carried by the
  :55-:00 maintenance break - so that sweep always runs while
  `isMaintenanceFrozen()` is true.
- The sweep's balance stage (and its expansion stage) is gated on the freeze.
  It skipped, the sweep completed, and nothing ever asked again: neither
  `MaintenanceBreak.end()` nor `resumeFromBreak()` requests a sweep.
- The same thing happened at 08:55 and 10:55. Between restarts the one
  non-frozen adoption (01:31) did try to break tables and was refused by the
  seat-exit guard (`Table break ... incomplete - 0/1 moved`), fixed at 08:22.

## The fix

- `freezeState.onNextMaintenanceThaw(listener)`: one-shot listeners run on the
  frozen -> thawed edge (a caller registering while thawed runs next
  microtask; a throwing listener costs nobody else).
- A sweep that skips balancing or expansion because of the freeze arms ONE
  urgent pass for the thaw, per manager and per freeze. Single-table formats
  (max_players <= table_size) never arm; a lifecycle that ended before the thaw
  asks for nothing; the passes are spread deterministically over the 10 s
  resume-wave window so a restart's worth of managers does not land on :00:00.

The freeze rule itself is unchanged: nothing is moved while frozen
(`theFreezeIsTotal.law.test.ts` still pins both guards verbatim).

Pinned by `server/src/tournament/aFrozenSweepOwesTheBalancerAPass.test.ts`.
