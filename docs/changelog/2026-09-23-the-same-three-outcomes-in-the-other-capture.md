# The same three outcomes, in the other capture

2026-09-23, one hour after the previous change. The release cleared the F06
permit refusal that had held it for four days and stopped one `require` later,
on the same table, for the same reason.

## What happened

`#5151` bounded `captureEngine.f06_custody_not_drained` (see
`docs/changelog/2026-09-23-the-fix-for-the-wedge-was-behind-the-wedge.md`).
The first release on the merged SHA, run 35927313976 at 22:22 UTC, got
further than any release since 2026-09-18 had: engine tests passed, every
production door passed, the image built and validated, the health gate
admitted the cutover past the unresolved preparation after the database
confirmed no hand was in the air, `prove_rollback_readiness` passed, the
legacy checkpoint was invoked, and it then refused:

```
reason: engine_work_not_drained
failedCheck: captureEngine.engine_work_not_drained
failedTable: 9e432569-5ebc-467a-9972-e450dfc0b296
stopped=true,terminal=true,scope=tournament,seats=6,banks=0,
boundary=1/false,permitPhase=attempted,f06=true/false,
fleet=446,fleetStopped=311,fleetF06=38,fleetBoundary=30
```

`boundary=1/false` is `terminalBoundaryPendingGenerations.size === 1` with
`terminalBoundaryPersistenceFailed === false`, on an engine holding an
`attempted` permit.

## Why that is the same trap, one level up

`physical()` - the capture that walks a retained original - has carried a
THREE-outcome rule on exactly this field since #5020 and #5021 merged on
2026-09-21, and its comment sets out the whole argument:

- an `attempted` permit ADMITS ONE. `beginTerminalBoundaryPersistence` has one
  call site, and on an engine holding a permit it runs inside
  `F06HandPermit.start`, one line after the phase becomes `attempted`. The
  integer IS that started, cut-off hand.
- a permit in any other phase REFUSES, before any row read. By the same
  argument the integer cannot exist in those phases, so the combination is an
  engine we do not understand.
- no permit at all DEFERS. With no permit there is no phase to reason from and
  no outstanding hand, so nothing downstream of HAND_COMPLETE can ever resolve
  the generation, and the rows must prove the felt quiet first.

`captureEngine` - which walks every table `physical()` does not - still
demanded a flat `size === 0`. So the shape the other path ADMITS refused here,
and the release stopped on it. That is CLAUDE.md 10.86 rule 4 exactly: a fix
that leaves the same trap one level up has not landed.

## What changed

`boundaryGenerationsAllowed(tableId, engine)` in
`server/scripts/legacy-engine-checkpoint-guard.mjs` returns the allowance the
drain require compares against, with the same three outcomes:

| state                                        | allowed  |
| -------------------------------------------- | -------- |
| `attempted` permit on a dead engine          | 1        |
| no permit at all on a dead engine            | deferred |
| any other permit phase                       | 0        |
| a LIVE engine, in any phase                  | 0        |
| a set holding anything but positive integers | 0        |
| more entries than a table can hold           | 0        |
| `terminalBoundaryPersistenceFailed === true` | 0        |
| unreadable                                   | 0        |

"Dead" is `deadEngineCustody`'s conjunction and nothing wider: stopped,
terminal, no hand controller, no recovery in flight, no live time bank. The
shape is proved before the count, so a malformed set refuses without a row
read. The deferred case goes into the same `deferredUnresolvableCustody` map
the previous change added, so `proveUnresolvableCustody` refuses unless the
rows prove that table quiet BEFORE anything is written - the same predicate,
the same three outcomes, the same refusal discipline.

Every other conjunct of `engine_work_not_drained` is untouched, and the law
asserts each of them by name.

## Pins, and the mutation test

Section 4 of `tests/a-preparation-that-can-never-resolve-is-not-a-hand.law.test.ts`
and eight behavioural cases in `tests/legacyEngineCheckpointGuard.test.ts`.

Seven mutations against 198 tests:

| mutation                                  | red |
| ----------------------------------------- | --- |
| the flat zero restored                    | 4   |
| an attempted permit admits any number     | 2   |
| any permit phase admits                   | 2   |
| the no-permit case waved through unproved | 3   |
| a live engine may carry a boundary        | 1   |
| the shape check dropped                   | 2   |
| a failed persistence becomes an allowance | 1   |

Baseline 198 of 198 green.

## What this does not claim

The engine has not shipped. This removes the second known wall; whether a
third exists will be visible in the next release run's refusal, which now
names its table, its shape and its permit phase in one line.
