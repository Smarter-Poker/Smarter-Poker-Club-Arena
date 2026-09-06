# The second look (V44)

2026-09-05. From the deep audit, section 5.3: _"Monte Carlo precision is
below the thresholds it feeds."_

Every live decision runs its equity sample at 120-450 iterations to stay
under the 15 ms budget (NLH 450, PLO4 220, PLO5 170, PLO6 120, governed lower
under load). At 120 iterations a 50% estimate carries +/-4.6 points of
standard error, and the V40 class caps it feeds sit 2-4 points apart. Then the
horse sits for 0.7-8 s of think time doing nothing. The budget the decision
needed is the budget the think time already spent.

## What changes

`HorseEval.setEquityDepth(mult)` multiplies every Monte Carlo sample in the
current decision, before the governor (so a saturated loop still wins).
`HorseLogic.decide` reads `opts.deepEquity` and brackets the call in
try/finally, so a throw cannot leave the depth raised for the next horse.

`ServerTableEngineTurns.scheduleHorseAction` snapshots the RNG before the
fast decision. When the spot is close - hero is facing a bet, the pot is
20bb+, the fast answer was a call, fold or all-in, the think time is 1.5 s or
more, and the equity governor is not shedding load - it replays the same
decision at `SECOND_LOOK_DEPTH = 6`, from the same strategy dice, a few
hundred milliseconds into the think time. If the deeper read lands on a
different call/fold/all-in, the deeper read acts. Bets and raises from the
replay are ignored: sizing is not what the sample decides. The RNG is
restored to the fast decision's position afterwards, for the same reason the
league brackets its runs (V12.3).

Cost: about one decision in twenty; PLO6 at 6x is ~40 ms of CPU on those.
The latency is recorded under its own scope (`deep:<variant>`) in
`horse_decision_latency`, so it never averages into the fast number.

## Proof

Receipts `v44_second_look` (expected ~0.5% of decides) and
`v44_second_look_flipped`. The flipped rate is the number to read: it is how
often the fast sample was wrong enough to change a call. If it is zero the
spots are not close; if it is high the fast budget is too small.

`HorseV44SecondLook.test.ts` (5): the spread of repeated estimates at 6x is
under 70% of the spread at 1x; the depth is bracketed and resets after a
throw; the RNG bracket replays identically and restores; the plan fires only
on a close spot with time and a calm governor, always inside the think time;
only a different call/fold/all-in overturns the fast answer.
