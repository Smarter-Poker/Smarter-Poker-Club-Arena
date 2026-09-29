# The fix for the wedge was behind the wedge

2026-09-23. One F06 hand permit, held by an engine that had already stopped,
kept every engine release on this platform shut for four days.

## What was measured

Production served `8825af51817f379c4261658ca29ecc9d8d81932d`, sealed
2026-09-18, about 190 commits behind `main`, with `stalledTableCount 65`.
Thirty-plus consecutive `auto-deploy-hetzner` runs failed. The newest,
run 35897820986 on `012b1013c9`, refused like this:

```
restart certificate is held shut only by {'f06_preparation_unresolved': 1}
reason: f06_custody_not_drained   retryAllowed: false
failedTable 9e432569-...  tournament 7c6277e7-...
stopped=true terminal=true seats=6 banks=0 meta=9 metaUnseated=3
permitPhase=attempted  fleetF06=38  fleetStopped=311  fleetOrphanBank=10
```

`permitPhase=attempted` is visible at all because of #5119, merged six hours
earlier the same day.

## The deadlock, stated plainly

An F06 permit is PROCESS-LOCAL. The engine that holds it resolves it, and
nothing else does: settlement finishes an `attempted` one,
`cancelPreparedHand` and `drainNeverStarted` finish the others. An engine that
is STOPPED and TERMINAL has run its teardown and will never deal again, so the
permit it still holds cannot be resolved by waiting. The only thing that clears
it is replacing the process.

Replacing the process is exactly what the refusal prevented.

Every fix written for this already existed on `main` and none of it could
reach production:

| change                                                       | merged           | on the running engine |
| ------------------------------------------------------------ | ---------------- | --------------------- |
| #4909 one stuck permit cannot hold the whole platform        | 2026-09-19 03:09 | no, sealed 09-18      |
| #5003 `F06_UNRESOLVED_GATE_MS`, the release gate asks the DB | 2026-09-21 08:22 | no                    |
| #5035 an abandoned break can still reach a terminal state    | 2026-09-21 17:12 | no                    |
| #5119 the refusal names the phase it turns on                | 2026-09-23 13:43 | control script, yes   |

The last row is the whole reason this was fixable today. The legacy checkpoint
guard and the release transaction are CONTROL SCRIPTS: they ship with the
release and are injected into the running engine, so a change to them takes
effect against the stale process immediately. A change inside
`server/src/**` cannot, by definition, until the engine it fixes has shipped.

## The two walls, both in the control script

**Wall one, `captureEngine`.** It required
`engine.f06CurrentPermit === null && engine.f06RecoveryInFlight === false`
for every engine in the fleet, with no bound, and the wrapper stamps
`retryAllowed: false` on every path. That is the same fail-closed shape, on
the same shared resource, that `MaintenanceBreak` bounded on 2026-09-21 and
that `engine-release-transaction.sh` bounded for the health gate in #5003. Its
own comment already records the argument: "Its engine needs replacing; the
permit is process-local and only that clears it."

**Wall two, the final readiness check.** It asked the predecessor's own
`maintenance.readyForRestart()`. On `8825af51` that boolean is false while any
table answers `hasUnresolvedF06Preparation()`, and that engine's
`unparkedTables()` has no bound at all, so it is false for ever. Admitting the
permit at wall one and then refusing on the same fact at wall two would have
moved the wedge rather than removed it (CLAUDE.md 10.86 rule 4).

## What changed

`server/scripts/legacy-engine-checkpoint-guard.mjs`:

1. `captureEngine` DEFERS, rather than refuses, a retained permit on an engine
   that is stopped, terminal, holds no hand controller, has no recovery in
   flight and holds no live time bank. The conjunction is deliberately narrow
   and deliberately does not repeat what every captured engine must already
   satisfy below it (`stopped_engine_not_released`, `engine_work_not_drained`,
   `native_accounting_not_drained`); a table that fails one of those still
   refuses the whole checkpoint exactly as before.

2. `proveUnresolvableCustody` proves every deferred table from rows before
   anything is written, with the ONE predicate this file already has for "a
   hand is in the air": an incomplete `hand_state_snapshots` row written inside
   `inflightWindowMs` (120 s), the same window `engine-release-inflight-hands.py`
   uses. Zero fresh rows is QUIET. Any fresh row is A HAND IN THE AIR and
   refuses. An error, a non-array body or a page that filled is COULD NOT TELL
   and refuses (CLAUDE.md 10.86 rules 1 and 2). The refusal code is
   `f06_custody_unresolvable_unproven`.

3. The readiness check asks the engine's own `readyForRestart()` first and is
   unchanged when it answers true. When it answers false, the fallback requires
   three witnesses: every reason the engine names is on the same ALLOW-list the
   release transaction uses (`f06_preparation_unresolved`,
   `f06_preparation_stuck`, and nothing else); every table this guard can see
   holding such a preparation is one the rows PROVED quiet; and the engine is
   not counting more blockers than the guard could identify. A blocker the
   guard cannot put a proved table id to is COULD NOT TELL, and it refuses.

4. The outcome is NAMED. `unresolvableCustody` carries
   `tables=N <tableId>:<permitPhase> ...` through `checkpointSummary` in
   `server/scripts/legacy-engine-checkpoint.mjs`, so a refusal that did not
   happen is still legible afterwards.

Nothing is written, no permit is resolved and no chip moves. The durable
`smarter_private.f06_*` rows are untouched and stay exactly as the settlement
agents will find them. What stops is a dead process's local object holding
every other table's restart certificate shut.

## What did not change

The checkpoint still refuses when a hand might be in the air. A permit on a
LIVE engine refuses. A stopped engine that still holds a live bank refuses. A
recovery in flight refuses. Unreadable refuses. There is no flag, variable or
argument anywhere in the new path that turns a refusal into permission, and
the law asserts that.

## Pins, and the mutation test

The law is section 4 of
`tests/a-preparation-that-can-never-resolve-is-not-a-hand.law.test.ts` -
deliberately the SAME law, not a new one, because this is the rule that law
already states applied one more time. Behavioural cases are in
`tests/legacyEngineCheckpointGuard.test.ts`.

Eight mutations, each reintroducing one part of the defect, against 186 tests:

| mutation                                 | red |
| ---------------------------------------- | --- |
| the unbounded refusal restored           | 7   |
| the row proof stops refusing             | 3   |
| readiness back to the raw boolean        | 2   |
| the reason allow-list dropped            | 2   |
| the count-equality identity link dropped | 2   |
| the live-bank conjunct dropped           | 2   |
| the proof moved after the first write    | 5   |
| the publisher drops the named outcome    | 1   |

Baseline 186 of 186 green.

The six existing cases that pinned "a permit on a stopped, terminal, empty
engine refuses" were moved, in this commit, to a LIVE engine, where that
refusal still happens and where the `permitPhase` observability #5119 added is
still pinned exactly as before.

## What this does not fix

A dead tournament manager can still hold a lease indefinitely with nothing
noticing: 48 of 423 `engine_tournament_leases` rows were past the reaper's
one-hour cutoff when this was written, the oldest dead for 47.6 hours, every
one retained by `f06_lease_has_pending_custody` and every one still naming the
live instance as its holder. That is the same unresolved permit seen from the
database side, and it is tracked separately.
