# An abandoned generation is not a pending one, and it is proved from rows

2026-09-21. The last thing holding the 59-hour engine freeze shut.

## What was refusing

Every `auto-deploy-hetzner` run today died at the same line, in the legacy
checkpoint guard that drains engine `8825af51` so its replacement can take
over:

```
{"ok":false,"reason":"mixed_original_work_not_drained",
 "failedCheck":"engineCollection.size",
 "failedTable":"2c621856-e728-4e8b-bf08-4c56746a8649",
 "failedField":"terminalBoundaryPendingGenerations",
 "observed":"1","expected":"0","restartAuthorized":false}
[legacy-engine-checkpoint] checkpoint or inspector cleanup refused; do not retry this operation
[engine-release-transaction] FATAL: legacy checkpoint or cleanup refused; release cannot continue
```

Behind it: six `RUNNING` tournaments with no lease, 49 seats and 4,908,000
tournament chips, the oldest derelict since 2026-09-14.

## The mechanism

`terminalBoundaryPendingGenerations` is an in-memory `Set<number>` on
`ServerTableEngineBase`. A number goes in at
`beginTerminalBoundaryPersistence()`, called immediately before
`controllerForHand.start()` (`ServerTableEngineDealing.ts`), and comes out at
exactly three sites:

| site                                                      | meaning                |
| --------------------------------------------------------- | ---------------------- |
| `ServerTableEngineDealing.ts` (start threw)               | the hand never started |
| `ServerTableEngineSettlement.ts` (postHandTasks rejected) | the boundary failed    |
| `ServerTableEngineSettlement.ts` (authoritative commit)   | the boundary succeeded |

**All three are downstream of `HAND_COMPLETE`.** `fenceTerminalEngine()` - the
body of `killForRestart()` - sets `this.handController = null` synchronously
and never touched the set. After a fence no `HAND_COMPLETE` can dispatch on
that engine, so no resolver can ever run: the number was unreachable and the
count could never reach zero. Not for a minute, not for a day, not ever.

That is the CLAUDE.md 10.86 shape exactly - a signal that answers confidently
when it cannot tell. The count said _pending_; the truth was _abandoned, and
nothing will ever resolve me_. Every reader above it, including the release
gate, correctly refused a restart on "a hand may be in flight".

## What the rows said

Read before anything was written, and re-verified for this change:

- Table `2c621856-e728-4e8b-bf08-4c56746a8649`, tournament
  `5a387a75-754a-416e-8fee-b85b15fc2702` "$100 Freeroll • 12:00 PM":
  **zero `hand_state_snapshots` rows, ever**. By the predicate PR #5003
  shipped - an incomplete snapshot written inside 120 s - no hand was in the
  air and none ever had been.
- Its three `smarter_private.f06_hand_permits`: `12942021`
  `aborted_unsettled` with 0 dispatches and 0 `hand_history` rows (never
  started); `12941732` and `12859817` `accepted`, one `hand_history` row each
  (settled durably).
- All six derelict tournaments (`5a387a75`, `615783bf`, `99271c16`,
  `45126295`, `7c6277e7`, `bfcfaf17`): **zero incomplete snapshots written in
  the last 120 s**. Five carry no snapshot rows at all; `7c6277e7` carries two
  incomplete rows last touched 2026-09-19 14:29 UTC, two days stale.

`7c6277e7` also carries two `reserved` permits. `reserved` is not terminal, it
is outside the two tournaments this guard profile handles, and nothing here
waves it through: `smarter_private.f06_mixed_custody_snapshot` already raises
`F06_MIXED_ORIGINAL_OMITTED` for a reserved permit that the local proof does
not carry, and the guard already requires `pending_original_tables` to be
empty.

## The fix, both halves

Either half alone is a defect, so both land together.

### A. The engine stops leaving an unresolvable generation behind

A **third named outcome - abandoned** - distinct from success and from
failure, carrying why and when, in
`terminalBoundaryAbandonedGenerations: Map<number, {reason, atMs, handNumber}>`.
`abandonTerminalBoundaryPersistence(reason)` is called from
`fenceTerminalEngine()` on the line immediately after `handController = null`,
because that is the line that makes the generation unreachable.

**Deliberately not `finishTerminalBoundaryPersistence(gen, false)`.** `false`
sets `terminalBoundaryPersistenceFailed`, which every reader - including this
guard - checks ONE STEP EARLIER, so the deadlock would move up a line rather
than end. It also asserts the boundary did not succeed, which is a fact not in
evidence: whether that hand settled is answered from the database, never from
the memory of a process that is already dead.

A fence can land while `postHandTasks` is still writing, so
`finishTerminalBoundaryPersistence` now also honours a late resolution of an
abandoned generation: **a late failure is still a failure** (it raises
`terminalBoundaryPersistenceFailed`), and a late success retires the
abandonment record rather than leaving a false one.

Blast radius, checked site by site: the only predicates that read the pending
set and could now answer differently are `captureDrainedF06Identity`,
`assertF06MovementOwner`'s stopped-quarantine branch and this guard - all
three are proofs about an engine that is already `terminal`, `!running`,
torn down and drained by a dozen other conjuncts. `parkForTerminalCloseout`
and `parkForTournamentMove` return on `!this.running` first;
`executeTournamentMoveAtBoundary`'s live branch requires `this.running`.
`maintenanceDurabilityReason()` does not read the set at all, so
`isMaintenanceStateDurable()` is unchanged. Nothing live gets looser.

### B. The guard proves abandonment from rows instead of refusing for ever

`physical()` is synchronous and cannot ask the database, and a drain check
satisfied with no row read is precisely the hazard this gate exists to prevent

- a direct route to voiding a live player's hand. So it does not decide. When
  the only unfinished item on a table is a boundary generation, and the engine is
  fenced and fully drained (`running === false`, `terminal === true`,
  `terminalTeardownComplete === true`, `hasReleasedProcessOwnership()`,
  `handController === null`, no dealing loop, no post-hand tasks, no snapshot
  flush, no preparation, no recovery in flight, and
  `terminalBoundaryPersistenceFailed === false`), the table is **deferred**.

`proveAbandonedBoundaries()` then runs **before** `sealAndRetireOriginals()`,
so a refusal means nothing was retired and no custody was transferred. For
each deferred table it asks `hand_state_snapshots` the exact question the
release gate already asks in `server/scripts/engine-release-inflight-hands.py`:
an **incomplete** row **written to in the last 120 s**. One definition of "a
hand is in the air", shared between the two files and pinned by the law, so
they cannot drift apart.

Three outcomes, never two. Zero fresh rows is QUIET. Any fresh row is A HAND
IN THE AIR. An error, a non-array body, or more deferred tables than the bound
allows is COULD NOT TELL - and it refuses, never folded into "no rows"
(10.86 rules 1-2). There is no flag, option, environment variable or argument
that turns the refusal into permission. The fleet and maintenance fence is
re-checked on both sides of every read, and a boundary set that MOVES between
observations refuses with the original code, because a set that moved is a
live boundary and not the abandoned one that was observed.

Shape is checked too: a set holding anything but positive safe integers, or
more of them than a table can hold, refuses without a row read.

## Observability

The guard emits `abandonedBoundaries` - which tables were proved abandoned and
how many generations each carried - carried verbatim through
`legacy-engine-checkpoint.mjs` alongside the `failedCheck` family added by
#5005. Nothing reads it; `ok` and `reason` keep their exact prior meaning for
every existing parser.

## What this is not

No cron, sweep, healer, backfill or repair job (10.12). No detector presented
as the fix (10.11). No migration, no money moved, no row written anywhere: the
guard proves and retires, it never edits an engine field. The defect is fixed
at the line that caused it.

## Pinned by

`server/src/engine/anAbandonedGenerationIsNotAPendingOne.law.test.ts` - both
halves, behaviour for the engine and structure for the guard, including the
shared 120 s window - and nine new cases in
`tests/legacyEngineCheckpointGuard.test.ts` driving the deferral end to end:
the happy path, a hand in the air, an unreadable answer, a body that is not a
list, two malformed shapes, a boundary that moves, a failed boundary, and the
case that reads no row at all because nothing was deferred.

## Related, and deliberately not duplicated

- **#5003 (merged)** - the 120 s incomplete-snapshot predicate. Reused, not
  reinvented.
- **#5013 (open)** - `engine-release-inflight-hands.py` with named exit codes.
- **#5010 (merged)** - a quarantined tournament manager as a counted state.

## Merged with #5011, which landed first - and reverts none of it

#5011 ("the 8825 drain guard accepts the interruption it retires", squash
`9bfa6401a8`, merged 09:33:47Z) touched the same line. It is not a competing
fix and it has not been weakened here: both mechanisms are kept, and the
PERMIT is what separates them.

### The measurement that decided the shape

After #5011 merged, `auto-deploy-hetzner` failed four more times - 09:34
(`9bfa6401`, the squash itself), 09:53 (`c2d69517`), 10:55 (`7f296c07`) and
12:48 (`079ba380`). Every SHA carries #5011's `allowed` line, and three of the
four runs' payloads were read back directly:

```
"failedCheck":"engineCollection.size","failedTable":"2c621856-...",
"failedField":"terminalBoundaryPendingGenerations","observed":"1","expected":"0"
```

`expected` is literally `String(allowed)`, and `failedField` is the field, so
`allowed` was 0 - which means **`interrupted` was false for this table** and
#5011's allowance never reaches it.

**Why it is false is `permit === null`, not an unadmitted phase.** The six
phases `F06HandPermit` can hold partition cleanly:

| phase                               | ruled out by                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`, `reserved`, `terminated` | the measurement above - these are exactly `interrupted`                                                                                                                                 |
| `attempted`                         | the rows: permit `12942021` is `aborted_unsettled` with 0 dispatches and 0 `hand_history` rows, so `HandController.start` was never reached and the phase never advanced to `attempted` |
| `number_refused`                    | `ServerTableEngineBase` clears `f06CurrentPermit` to null on a known number refusal                                                                                                     |
| `new`                               | `reserveF06Hand` installs the permit and `reserveOriginal` sets `unknown` with no await between, and the guard separately requires `permit.reserveInFlight === false`                   |

Nothing is left but `null`. That is also the shape the guard already names one
function away: `allocationBacked` filters on `e.permit === null &&
e.allocationEpoch !== null`, above the comment "8825 retains the original
allocator epoch **after an accepted hand clears its local permit**".

### The resolution

`physical()` now has three outcomes on this one field instead of two:

- `permit !== null && interrupted` - #5011 admits ONE entry, and
  `sealAndRetireOriginals` still refuses the run with
  `mixed_original_disposition_unproven` unless the database proves that permit
  `aborted_unsettled` against a receipt naming this engine, manager and
  container.
- `permit !== null && !interrupted` - #5011 REFUSES, `expected` 0, before any
  row read and before any RPC. A permit in any other phase is a hand that MAY
  HAVE STARTED; it is not an abandoned generation and must not become one.
- `permit === null` - #5021 DEFERS, and `proveAbandonedBoundaries` proves the
  felt quiet from rows before anything is retired.

Gating the deferral on `permit === null` rather than on `!interrupted` is
deliberate and is the narrower of the two: every #5011 test passes unchanged,
including `refuses a reserved terminal boundary that no undischarged permit can
discharge`, which asserts that refusal happens with `rpcCalls` still empty.

### Ordering, unchanged and still load-bearing

```js
await proveAbandonedBoundaries(checkAll); // rows: is the felt quiet?
await sealAndRetireOriginals(checkAll); // custody: who holds the interruption?
```

Both still precede `sealAndRetireOriginals`' committing RPC, the custody RPC
and the retirement CAS. They do not short-circuit each other and share no
state: the first reads `deferredAbandonedBoundaries` and returns immediately
when it is empty, the second reads `retainedManagers`. A refusal in either
means nothing was retired and no custody moved.

**They are not substitutes, and a new test says so.** `refuses a deferred
manager that holds no interrupted original at all` pins that proving the felt
quiet is not a route past the disposition proof: this profile has required
exactly one interrupted original per manager since long before #5011, and a
manager without one is refused with `mixed_original_disposition_set_changed`
after the row proof and before the committing RPC.

### Tests and laws reconciled

- `tests/legacyEngineCheckpointGuard.test.ts` - both suites kept. #5011's
  cases still drive a permit-holding original; #5021's now drive
  `abandonedOriginal()`, a second original on the same manager holding no
  permit, which is the shape the rows actually show. 82 pass.
- `server/src/engine/anAbandonedGenerationIsNotAPendingOne.law.test.ts` - the
  assertion pinning the pre-merge `drained(size === 0, ...)` else-branch was
  orphaned by #5011 rewriting that line; it now pins the merged `size <=
allowed` expression, plus a new case pinning that the deferral and the
  allowance are disjoint.
