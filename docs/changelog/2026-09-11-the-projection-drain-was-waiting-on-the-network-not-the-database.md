# The Projection Drain Was Waiting On The Network, Not The Database

Before: `hand_projection_outbox` had 42,078 rows, the oldest 77 minutes old, and was growing.

Measured on the live engine 45 minutes into a clean start, with nothing else wrong:

|                             |                            |
| --------------------------- | -------------------------- |
| hands dealt                 | 825 / min                  |
| rows projected by the drain | **295 / min**              |
| net outbox growth           | ~530 / min                 |
| drain passes                | 0.31 / min, ~950 rows each |

A drain running at 36% of the rate hands arrive does not have a backlog. It has an unbounded queue. It had been in this state for a long time and restarts were hiding it: each one clears the in-flight work, so the depth reads as a spike rather than a slope, and the wedge fixed earlier the same day was a separate fault layered on top of it.

## The lever is lanes, and the numbers say which

`HandProjectionOutboxBacklog`'s runbook names the lever and sets a precondition: _"Raise HAND_PROJECTION_DRAIN_CONCURRENCY (default 4, max 16) only after reading pg_stat_activity for lock waits on hand-projection:&lt;table&gt;."_

That check, and the rest of the evidence:

|                                     |                                                         |
| ----------------------------------- | ------------------------------------------------------- |
| `fn_project_hand_side_effects` mean | **28.3 ms** over 1,024,621 calls (`pg_stat_statements`) |
| one chain, end to end               | **~810 ms**                                             |
| lock waits on hand-projection       | **0**                                                   |
| backend sessions active             | 9 of 99                                                 |

So roughly **97% of every chain is a round trip between Hetzner and PostgREST**, and the four lanes spend nearly all their time waiting rather than doing. The database is not busy, is not locked, and is answering in 28 milliseconds.

That is the same shape as the horse decision lane found earlier the same day: work that is network-bound, serialised behind a conservatively small default, costing nothing on the event loop while it waits.

Correction: `HAND_PROJECTION_DRAIN_CONCURRENCY_DEFAULT` goes from 4 to 16, the ceiling `HAND_PROJECTION_DRAIN_CONCURRENCY_MAX` already sanctions. At ~810 ms a chain that is roughly 1,180 rows a minute against the 825 that arrive: it reverses the slope and works the backlog down at about 355 a minute rather than merely slowing the growth.

The ceiling is not raised. 16 is enough to reverse the deficit, and going past a bound somebody already chose deserves its own measurement rather than an assumption made at the same time.

Verification: the measurements above are all from production, not from a model. The lock-wait check the runbook asks for was done before the constant changed, not after. `handProjection.test.ts` pins the new default and the reason for it; 27 tests pass.

Not changed: `DRAIN_PAGE` (100) and `DRAIN_MAX` (1,000). Neither is the limiter. A pass that hits `DRAIN_MAX` queues a coalesced continuation immediately, so the pass boundary costs nothing; what costs is how many chains are in flight inside it.
