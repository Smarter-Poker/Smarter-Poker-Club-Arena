# The refusal that could not name what moved

**2026-09-21.** #5026 gave the release its window back. Run 35623804237, on
`91fcf87e44` - the first release to carry the timing ladder - arrived inside a
genuine freeze, reached the guard, and died anyway:

```
{"ok":false,"reason":"mixed_owner_changed","checkpoint":{
  "stage":"preflight","attemptedTables":0,"completedCalls":0,
  "checkpointOutcome":"not_started","restartAuthorized":false,
  "failedCheck":"manager.captureDrainedF06Originals()","failedTable":"none"},
 "retryAllowed":false,"checkpointInvoked":true,"inspectorClosed":true}
```

The engine stayed on `8825af51`. Two separate defects are in that one line.

## What "mixed owner" is

The 8825 predecessor has no native mixed-custody adoption method, so the
checkpoint transfers custody of two tournaments -
`5a387a75-754a-416e-8fee-b85b15fc2702` and `615783bf-15e3-40b7-9368-75f21b6ac53b`,
named in the sealed intent - by preserving the predecessor's own objects and
proving, before and after, that it still owns them. "Owner" is that set of
object identities: `server.tournamentEngines`, the manager at the tournament's
key, `server.tournamentRetirementCustody`, `server.tournamentOwnedTables`,
`server.unregisterTournamentTableEngine`, `manager.gameServer`, the drained F06
originals, the pending retirement, the seat-move revision and serial tail, and
the exact maps, sets and engines. `mixed_owner_changed` means one of those
stopped being what the guard read. `fleet_identity_changed` is the same shape
one level out: `tableMap` gained, lost or replaced a table.

Both are capture-then-reverify checks, and the window between the two is not
small. `checkMaintenance()` re-runs them, and so does every page of the
`engine_presence_parked` readback - real Supabase round trips, across which the
predecessor's event loop keeps running.

## 1. It cannot name its own cause

`witness` was built for exactly this: it splits a wide conjunction into its
original sub-expressions and names the one that refused. It did its job -
`failedCheck` says `manager.captureDrainedF06Originals()`. But that call is
itself a **fourteen-term conjunction** inside the predecessor
(`TournamentManagerBase.captureDrainedF06Originals`) which returns a bare `null`
for any of them: `stopFenceApplied`, `tournamentLeaseAuthorityExpired`,
`running`, `teardownPromise`, `lifecycleOperation`, five job sets, two timer
sets, the engine count, and four per-engine conditions. One opaque atom, and the
receipt names the function.

`failedTable: "none"` reads like an answer and is not one: it is computed by a
_different_ predicate (the `tableEngines`/`ownedTables` identity), so it says
nothing about the fourteen.

Worse, `checkpointSummary` carries observability fields through a closed
allow-list, and `failedMap`, `failedSet`, `seatMoveRevision` and
`capturedSeatMoveRevision` were **not on it**. The guard had computed all four
and they were dropped between the guard and the runner. CLAUDE.md 10.86 rule 2:
an unreadable answer must never be coerced into an empty one.

**Fixed, and then reconciled on merge (2026-09-21).** This branch first shipped
its own diagnosis, `failedDrain`, and widened `checkpointSummary`'s allow-list
to let the four dropped fields through as keys of their own. #5034 landed the
same fix on `main` a few hours earlier and better: `drainWitness` names EVERY
condition that sent the capture to null rather than only the first - the same
thirteen terms plus `tableEngines.length` and `engineNotDrained` - and it
travels, with the tournament, the map, the set and both seat-move revisions, in
`observedDetail`, the one carrier that is already allow-listed.

So `failedDrain` is gone and the allow-list widening with it. Two instruments
answering one question is not a stricter repo; it is a coin flip decided by
whichever the next agent reads first, and a key that has to be remembered in a
fixed allow-list is exactly the thing that failed here in the first place. What
this branch DID carry forward is the guarantee, not the code: `drainWitness`
now keeps three answers apart instead of two, because a term whose read THREW
was being reported under the name of a term that moved. It reports
`<term>:unreadable` instead, and `none` still means "the capture flipped and
every term below still holds, so the cause is outside this list" (CLAUDE.md
10.86 rule 1). It is computed inside `witness`'s `extra()`, on a path that is
already refusing, under a catch that discards it: no check, threshold or
outcome moves.

## 2. It killed a release it had not touched

`stage: preflight`, `attemptedTables: 0`, `completedCalls: 0`,
`checkpointOutcome: "not_started"`, `restartAuthorized: false`, inspector
closed. **Nothing was touched, and the release ended permanently.** #5026 had
already established the answer for this exact shape: `defer()`, exit 75, "this
attempt arrived late" is a different fact from "this attempt is unsafe".

That deferral was reachable only ABOVE the helper's `O_EXCL` intent write. That
is right for a _disconnect_ - an inspector opened and nobody came back, which is
unknown, and unknown is never permission to invoke again. It is wrong here,
because here **the guard answered**, closed its inspector, and handed over a
complete receipt saying what it did: nothing.

**Fixed, reusing #5026's mechanism rather than inventing a second.**
`deferrableCheckpointRefusal` reads that receipt - never infers - and the node
helper exits 75 instead of 1 only when the receipt says, in its own fields,
that it refused in preflight having attempted no table, completed no call,
verified nothing, read no bank, authorised nothing, and closed its inspector
with no connection left. The shell then proves the intent on disk is **byte for
byte the one this entry wrote**, retires it, and defers under a deliberately
different name, `defer_proved_not_started`, so the two deferrals can never be
widened into each other. A foreign intent, a truncated one, or none at all is a
`die` and a retry stays forbidden. **The transaction is unchanged**: its own
filesystem proof is still the final arbiter of whether 75 is honoured.

The deferrable list has two groups and nothing else.

**Overtaken while reading**: `server_changed`, `fleet_identity_changed`,
`mixed_owner_changed`, `mixed_local_custody_changed`.

**Arrived late**: `insufficient_reserve`. This one was going to be left out, and
the runs decided otherwise. Twenty minutes after the ladder shipped, run
35625997626 failed at 16:30 on exactly that code, with a byte-identical
non-acting receipt - `stage: preflight`, `attemptedTables: 0`,
`completedCalls: 0`, `checkpointOutcome: "not_started"`, inspector closed.
"The break window closed before the checkpoint could start" is the sentence
#5026 wrote `defer()` for; the guard's own copy of that finding simply sat
below the intent boundary, which is the boundary this change moves. **The
285000ms floor does not move.** The guard refuses on the identical reading at
the identical threshold; only the consequence changes. And a late arrival that
got past preflight is still fatal, because by then "nothing was attempted" has
stopped being true.

Every `maintenance_*` code stays fatal - those are what stop a cutover being
certified over a hand in the air. `bank_park_write_incomplete` stays fatal: it
is real durable time-bank state, not a timing finding.

**This widens no tolerance.** The four refusals still refuse, nothing is
retired, and the next attempt re-proves every one of them from scratch against a
fresh break. All that changes is that an attempt which provably did not act
stops poisoning every later one. It is not a cron, sweep, healer or repair job
(CLAUDE.md 10.12) - it is one release attempt standing down.

## What moved is still not named, and that is the honest state

`captureDrainedF06Originals` reads no rows; every one of its fourteen terms is
process-local to the predecessor. So this is **not** the stuck-F06 churn being
worked as a separate item: `smarter_private.f06_operations` for both custody
tournaments was written on 2026-09-18 (12 acknowledged / 2 begun / 4
park_requested, and 11 / 1 / 6) and has not moved since - the engine froze at
21:55:50 that day. Nor is it something `zz_freeze_guard` covers: CLAUDE.md 13
freezes money and seats **in Postgres**, and a job set, a lifecycle timer or an
engine's settlement flag inside a fenced manager is not a row.

Two of the fourteen can be excluded by reading: `tournamentLeaseAuthorityExpired`
and `stopFenceApplied` are monotonic - nothing sets either back. The rest cannot
be told apart from outside the process, and that is the point: **the receipt is
the only instrument, and it was blind.** The next refusal names the field.

The engine's own code, incidentally, treats the identical transition as
ordinary: `TournamentManager.captureDrainedF06Custody` runs the same
capture-then-reverify across the same kind of await and, when `current()` goes
false, `return null` and tries again later. Only the release turned it into a
death.

## Law

`tests/a-race-that-touched-nothing-names-it-and-waits.law.test.ts` pins both
halves. The diagnosis is coupled to the engine, not to a word count: it parses
`captureDrainedF06Originals` out of `TournamentManagerBase.ts` and requires
`drainWitness` to name every field it reads, so a fifteenth term cannot be added
without teaching the guard about it. It also pins the carrier from both ends:
`checkpointSummary` must allow-list `observedDetail`, the witness call must put
all four sub-conditions in it, and NONE of them may ride as a key of its own
where that fixed list would silently bin it. The predicate is driven against the real
35623804237 receipt and eighteen mutations of it, plus the eight reasons that
must stay fatal and the past-preflight late arrival that must also stay fatal. The shell block is driven as a real subprocess: matching bytes
defer and retire, foreign bytes die and **preserve**.

`tests/the-release-enters-the-break-with-time-to-finish.law.test.ts` carried the
pin "below the intent, only `die`". That sentence is no longer true, so it is
narrowed in this same commit (CLAUDE.md 5.8) to what still is: the
_unconditional_ `defer` can never be reached once the intent exists, and the one
deferral below it is the proved one.

## Files

- `server/scripts/legacy-engine-checkpoint-guard.mjs`
- `server/scripts/legacy-engine-checkpoint.mjs`
- `server/scripts/legacy-engine-checkpoint.sh`
- `tests/a-race-that-touched-nothing-names-it-and-waits.law.test.ts`
- `docs/laws.d/tests-a-race-that-touched-nothing-names-it-and-waits.md`
- `tests/the-release-enters-the-break-with-time-to-finish.law.test.ts`
