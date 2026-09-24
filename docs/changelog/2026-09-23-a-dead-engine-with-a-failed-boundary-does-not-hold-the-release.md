# A dead engine with a failed boundary does not hold the release

2026-09-23. The third wall, after the F06 permit refusal (#5151) and the
boundary count in the other capture (#5155).

## What was wrong

Every engine release was refused at the legacy checkpoint preflight:

```
reason: engine_work_not_drained
failedCheck: captureEngine.engine_work_not_drained
stopped=true,terminal=true,scope=tournament,seats=3,banks=0,...,
f06=true/false,permitPhase=attempted,settling=0,postTasks=false,moves=0,
boundary=0/true,accounting=0,...,fleetStopped=311,fleetF06=38,fleetBoundary=30
```

Read term by term, every conjunct of the drain require held except one:
`boundary=0/true` is an empty `terminalBoundaryPendingGenerations` with
`terminalBoundaryPersistenceFailed === true`. The require demanded that flag be
exactly `false`, and `boundaryGenerationsAllowed` returned 0 whenever it was not.

Build 8825af51, which production runs, sets the flag when a hand fails to start
or to settle its boundary and clears it only when that same engine completes a
later boundary. A stopped, terminal engine never deals again, so on such an
engine the flag can never clear. The only thing that can remove it is replacing
the process, and the refusal prevented exactly that: the same fail-closed-for-ever
shape #5151 bounded for a permit. `physical()`, the capture that walks retained
originals, carried the same flat `=== false` twice (the drain check and the
abandoned-generation shape), so fixing only the capture would have moved the
refusal one check up (CLAUDE.md 10.86 rule 4).

## What changed

`server/scripts/legacy-engine-checkpoint-guard.mjs` gains
`failedBoundaryOnDeadEngine(tableId, engine)`. It returns true only when the
flag is exactly `true` AND the engine meets the dead-engine conjunction that
`boundaryGenerationsAllowed` already applies and `deadEngineCustody` shares:
stopped, terminal, no hand controller, no F06 recovery in flight, and a readable
empty live bank map. When it returns true it puts the table into
`deferredUnresolvableCustody`, labelled `<permitPhase>/boundaryFailed`.
Unreadable is never dead.

It is consulted in exactly four places, each of which used to demand `false`:

- the `engine_work_not_drained` require in `captureEngine`;
- `boundaryGenerationsAllowed`, so a dead engine with a failed flag keeps the
  same three outcomes on its pending generations as one without;
- the `engine.terminalBoundaryPersistenceFailed` drain in `physical()`;
- the abandoned-generation shape in `physical()`.

A deferral is not a proof. `proveUnresolvableCustody` runs before any presence,
bank or custody row is written and refuses the whole checkpoint with
`f06_custody_unresolvable_unproven` unless the database shows no fresh incomplete
`hand_state_snapshots` row for the table. A hand in the air refuses; a read the
guard could not make refuses. For a retained original, the disposition proof in
`sealAndRetireOriginals` still demands its receipt afterwards.

Nothing else moved. A live engine, a stopped engine with a hand controller, a
live bank, a settlement, post-hand tasks, move operations, accounting work or a
recovery in flight refuses exactly as before, with the same code, and reads no
row. A flag that is not a boolean refuses. No timer, watcher, retry, option or
bypass variable was added.

## Verification

`tests/legacyEngineCheckpointGuard.test.ts`, with new cases built from the exact
observed shape (8825 profile, stopped tournament engine, three seats, no banks,
an `attempted` permit, `boundary=0/true`):

- the dead engine is deferred to the row proof and the checkpoint writes and
  reads back the live fleet; without its permit the whole run completes;
- the same engine with a fresh incomplete snapshot, or an unreadable one,
  refuses `f06_custody_unresolvable_unproven` and writes nothing;
- the same flag on a live engine, a live bank, a settlement, a move, post-hand
  tasks, a hand controller or a recovery in flight refuses exactly as on main,
  with no row read;
- `physical()`: an interrupted original and an abandoned original with the flag
  are proved from rows (and refused on a hand in the air); one holding a live
  bank still refuses `engine.terminalBoundaryPersistenceFailed`.

Three existing cases that pinned the old refusal on a dead engine were replaced
in the same commit by the deferral cases above. With the guard change removed,
the ten new deferral cases fail (the observed shape refuses
`captureEngine.engine_work_not_drained` with the production detail, verbatim);
with it, all 188 pass. `tests/a-preparation-that-can-never-resolve-is-not-a-hand.law.test.ts`
section 5 pins the source shape. The server tests that import the guard
(`EngineLifecycleDiagnostics`, `anAbandonedGenerationIsNotAPendingOne`,
`HistoricalBankCheckpoint8825`) pass; the native drain case for this field now
faults a not-dead original, which is the refusal it still pins.

## What this does not claim

The engine has not shipped. Whether a further wall exists will show in the next
release run's refusal detail.
