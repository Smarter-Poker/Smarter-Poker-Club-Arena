# 2026-09-24: a teardown a dead process can never finish is answered from rows

## What was wrong

Every engine release since 2026-09-18 is refused at the legacy checkpoint
preflight, and the live process is still the old build 8825af51. #5190, #5195
and #5198 each cleared one refusal of a dead engine. The 14:55 UTC release (run
36015361207, head cb8a89021d) then stopped at the join on previous native work:

```
failedCheck previousNativeWork.teardown  failedTable 6557ebd8-b75e-4ad6-a9b6-80948ebc5f4e
unfulfilled=8,joined=738,presenceSave=0,teardown=8,stopped=true,scope=tournament,
tournament=056e5fc8-08e0-4308-a8fb-9f09e5fc182e,reason=Table engine ... teardown failed in operation
```

Eight stopped table engines of one tournament whose lease the old process lost.
Their teardown rejected, and 8825's `stop()` memoizes that promise
(`ServerTableEngineBase.ts:3417`), so it is rejected for ever. Nothing in the
old process will run it again. The only thing that ends it is replacing the
process, which is exactly what the refusal blocked (CLAUDE.md 10.86).

## Why admitting it loses nothing, on 8825

The rejection is the `AggregateError` 8825's `performStop` throws at its END
(`:3613`), after every cleanup step has run. It collects from exactly three
places:

1. an owned writer it joined rejected (dealing loop, settlement, post-hand
   tasks, tournament move, read continuation, `:3486`). Each has already
   settled; what it committed is in the database, and a hand it left open is an
   incomplete `hand_state_snapshots` row, which the row proof reads.
2. the terminal snapshot flush failed (`:3545`). A failed write changes no row,
   and `checkCrashRecovery` takes only the hand number and disconnect states
   from that row, marks the hand complete and leaves stacks as the rows hold
   them. Completion is a separate write (`complete_hand_snapshot`).
3. a module dispose threw (`:3595`): process memory only.

A seat boundary (cashout) failure rejects with its own error before any cleanup
and does not carry that sentence, so it still refuses. The banks and presence
this checkpoint persists are already asserted empty on a stopped engine by
`stopped_engine_retains_custody`.

## The fix

`server/scripts/legacy-engine-checkpoint-guard.mjs`: `deadTeardownFailureDeferred`
admits a rejected `teardown` join only when all of these hold, and otherwise the
join refuses exactly as before:

- the predecessor is 8825 (`retained8825`). Later builds also record a failure
  to capture a stopped tournament table's time banks in the same
  `AggregateError`, so there a failed teardown can hide an uncaptured bank;
- the capture is stopped, the teardown is the pinned one, and the engine is
  not running, terminal, `terminalTeardownComplete === false`, has released
  process ownership, has no hand controller, no dealing loop, no F06 recovery
  in flight and no live time bank;
- the rejection is an `AggregateError` with at least one error and exactly the
  message `Table engine <this table> teardown failed in <errors.length> operation(s)`.

An admitted table is not waved through. It goes into the same
`deferredUnresolvableCustody` map #5190 and #5195 use, and
`proveUnresolvableCustody` refuses the whole checkpoint unless the rows prove
it quiet before anything is written. A `presenceSave` join never defers. The
refusal detail now also carries `teardownDeferred=<n>`.

## Tests

`tests/legacyEngineCheckpointGuard.test.ts`, built from the observed detail:
the eight dead teardowns are deferred and proved from rows; a hand in the air
or an unreadable row proof still refuses; a non-8825 sentence, the sentence for
another table, a mismatched count, an empty `AggregateError`, a completed or
missing `terminalTeardownComplete`, a recovery in flight, a failed presence
write and a later predecessor all still refuse with their original code.
