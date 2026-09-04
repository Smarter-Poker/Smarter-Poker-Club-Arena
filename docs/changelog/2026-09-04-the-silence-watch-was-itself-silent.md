# The silence watch was itself silent

**2026-09-04, after the merge.** Both pull requests landed and the engine
deployed. Verifying against production found the Free Buy board publishing and
the table trim executing — and two features that had shipped, passed every
check, and were doing nothing at all.

## What was actually live, and how it was proved

|                       | evidence                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free Buy board        | 4 events: Afternoon Free Buy at 16:00 Chicago on BOTH hosts (RUNNING), Prime Time at 20:00 on both (REGISTERING). Created at 20:00 and 22:00 UTC — after the deploy, by code that did not exist before it. |
| Exotic and limit trim | 223 tables marked `retire_when_empty`, in waves at 20h/21h/22h, in exactly the trim's signature: short_deck 40, plo8 38, pineapple 32, flo8 25, flh 20.                                                    |
| Retirement pass       | 1,864 tables closed in three hours, 189 of them carrying the flag.                                                                                                                                         |

## Failure 1 — the heartbeat call was deleted by a refactor

`stable_hand_beats` held **zero rows** through four hours of live running.

The chip-continuity refactor rewrote the block around the stands and took
`writeBeats` and `checkBanks` out with it. The imports stayed. `checkBanks`
stayed defined. `npx tsc --noEmit` stayed clean. 5,371 tests stayed green. The
feature built to notice silence was itself silent, and the only reason it was
found was a hand query against the counters it should have written.

**An import is not a call, and a defined method is not a called one.** My own
Part C wiring check verified that each new module was imported by something —
which was true, and useless. Both calls are restored, and eight pins now hold
the cycle: each step asserted by name inside `cycle()`'s own body, the beat
written _after_ the stands, the counters cleared _after_ the beat, plus two
generalised guards — nothing imported from `StableHandBeats` may go unused, and
no `private` method may be defined and never called.

## Failure 2 — the tag book loaded on a laptop and returned null on the engine

`stable_hand_horse_state.counters_reset_on` was **NULL on all 1,000 rows**: no
sit counted, no minute accrued, no two-hour window opened. Running the exact
same code paths locally against production returned a complete book — 1,580
tags, 1,000 states — so the code was not broken; the engine was not getting one.

`load()` returned null unless **both** reads succeeded. Tags are read once every
ten minutes; states were on a 25-second TTL against a 30-second cycle, so a
1,000-row read ran on essentially every pass. One slow read there switched off
the entire tag layer — variants, stakes, lanes, table ceilings — and wrote no
counter, without a word.

Two fixes, and the second is the real one:

- **The state TTL is 60 seconds.** The shorter value bought nothing: this cycle
  folds its own writes back into the cached map before the next one reads it,
  and there is no other writer.
- **The tags are the book; the states are an annex.** A book now returns as
  soon as the TAGS are available, with whatever states it has. Every state
  reader already fails open on a missing row — `dailyCapReached(undefined)` is
  false, the mutex block skips a horse with no state — so tags-without-states is
  a small, honest degradation where returning null threw everything away.

## And both failures are now visible from the database

Failing open is correct. Failing open _silently_ is what cost four hours.

- An unread tag book raises a `financial_alerts` row, throttled hourly, saying
  the tag layer is off and the fleet is unharmed.
- Dropped counter updates are counted and logged rather than vanishing.
- The whole bookkeeping section is wrapped, so a throw there is reported
  instead of being swallowed by the cycle's outer catch — which is how it could
  have taken the counters, the heartbeat watch and the flush together, leaving
  no trace.

## Verified

Server typecheck clean, 5,381 tests across 372 files. Re-run against production
after the fix: book `tags=1580 states=1000`, beats built and written and read
back, probe rows removed.
