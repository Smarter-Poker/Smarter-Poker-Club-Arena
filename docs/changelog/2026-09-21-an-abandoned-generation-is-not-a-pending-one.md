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

## Merged with #5011 and then #5020, and reverts neither

Two PRs touched the same line while this one was open, and the second corrected
the first. Both are kept; nothing here weakens either.

- **#5011** (`9bfa6401a8`, 09:33:47Z) admitted ONE entry on this field for an
  engine still holding the hand's permit, where `interrupted` was
  `permit !== null && ['unknown','reserved','terminated'].includes(phase)`.
- **#5020** (`db885b2941`, ~14:30Z) replaced that triple with
  `permit !== null && capture.phase === 'attempted'`, on the ground that
  `beginTerminalBoundaryPersistence` has ONE call site, that it runs inside
  `F06HandPermit.start` one line after the phase becomes `attempted`, and that
  the phase cannot leave `attempted` afterwards. It also added
  `failedPermitPhase` to the refusal payload, and widened
  `sealAndRetireOriginals` to DEMAND the `aborted_unsettled` receipt of an
  `attempted` permit too.

### A correction, recorded because it was load-bearing while it stood

While #5011 was the merged state, this branch reasoned from the four failing
runs (09:34, 09:53, 10:55, 12:48 - all carrying #5011's code, three payloads
read back directly) that `expected:"0"` proved `interrupted` false, and then
concluded from the permit rows that the reason must be `permit === null`.

**That conclusion was wrong, and production disproved it.** The first two runs
on #5020's SHA (`35613147982` at 14:35, `35614192763` at 14:44) no longer refuse
on `terminalBoundaryPendingGenerations` at all - they get past the drain check
and stop later, at `fleet_identity_changed` and `mixed_owner_changed`. A
generation that is now admitted is a generation whose phase is `attempted`. So
`interrupted` was false under #5011 because #5011's triple omitted `attempted`,
exactly as #5020 says, and not because the permit was gone. The "never started"
reading of permit `12942021` (0 dispatches, 0 `hand_history`) describes a hand
that was cut off after `start` was actuated, not one that never reached it.

### The resolution

`physical()` has three outcomes on this field instead of two:

- `permit !== null && phase === 'attempted'` - #5020 admits one, with its
  receipt demanded downstream.
- `permit !== null && phase !== 'attempted'` - refuse, `expected` 0, before any
  row read and before any RPC. By #5020's own argument the integer cannot exist
  in those phases, so the combination is an engine we do not understand: fail
  closed, never defer.
- `permit === null` - defer, and prove the felt quiet from rows.

The deferral is gated on `permit === null`, not on `!interrupted`. That leaves
#5020 byte-for-byte wherever a permit exists - its refusal, its `expected` and
its new `failedPermitPhase` - and covers only the gap its phase argument cannot
reach, since with no permit there is no phase to reason from.

**So this PR no longer unblocks the 8825 cutover; #5020 did that.** What it
still carries is the half #5020 does not: the ENGINE-side third named outcome,
so a fence stops leaving an unresolvable generation behind at all (10.11, the
root fix rather than a guard that tolerates it), plus the row-proved net under
the one shape the guard could still refuse for ever.

### Ordering, unchanged and still load-bearing

```js
await proveAbandonedBoundaries(checkAll); // rows: is the felt quiet?
await sealAndRetireOriginals(checkAll); // custody: who holds the interruption?
```

Both precede the committing RPC, the custody RPC and the retirement CAS. They
share no state and neither short-circuits the other: the first returns
immediately when `deferredAbandonedBoundaries` is empty, the second reads
`retainedManagers`. A refusal in either means nothing was retired.

**They are not substitutes, and a test says so.** `refuses a deferred manager
that holds no interrupted original at all` pins that proving the felt quiet is
not a route past the disposition proof: this profile has required exactly one
interrupted original per manager since long before #5011, and a manager without
one is refused with `mixed_original_disposition_set_changed` after the row proof
and before the committing RPC.

### Tests and laws reconciled

- `tests/legacyEngineCheckpointGuard.test.ts` - all three suites kept, 89 pass.
  #5011's and #5020's cases still drive a permit-holding original; this PR's now
  drive `abandonedOriginal()`, a second original on the same manager holding no
  permit.
- `server/src/engine/anAbandonedGenerationIsNotAPendingOne.law.test.ts` - the
  assertion pinning the pre-merge `drained(size === 0, ...)` else-branch was
  orphaned when #5011 rewrote that line; it now pins the merged `size <= allowed`
  expression, plus a case pinning that the deferral and the allowance are
  disjoint. 16 pass.
