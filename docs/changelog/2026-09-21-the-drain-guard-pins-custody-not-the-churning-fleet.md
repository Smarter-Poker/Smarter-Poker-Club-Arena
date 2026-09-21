# The Drain Guard Pins The Custody It Retires, Not The Churning Fleet

Date: 2026-09-21. `server/scripts/legacy-engine-checkpoint-guard.mjs` and
its tests only. No migration, no client change, no engine change, no
workflow change. Nothing was deployed by this commit; the installed control
generation picks it up on its next ordinary install.

## What was wrong

With the budget fixed (the preceding changelog, "The Legacy Checkpoint Gets
The Seconds It Needs"), the exact 8825 legacy checkpoint reached its custody
proof and then refused twice more, on two stability witnesses that were
written against a quiet fleet. The live 8825 engine is not quiet.

### 14:42:12Z - `fleet_identity_changed` (run 35613147982, `fleet.size`)

`checkMaintenance()` snapshotted `server.tableEngines` once (`entries`) and,
on every re-check, required the whole map to still have exactly
`entries.length - retiredOriginals.size` tables, each the same object.

The live engine re-admits and kills the cash table
`3c00d4d0-5d98-44de-ad36-cd683001d32a` every ~5 s - about 12 admissions a
minute - and it sits in `tableEngines` for 0.6-4 s of each cycle. The
checkpoint's proof RPCs take longer than the gap, so `fleet.size` was false
at some `checkMaintenance()` on every attempt. That table is a foreign cash
table: it is not captured, not selected for retirement and not a retained
original. Its arrival or departure cannot move the custody this checkpoint
retires.

### 14:55:10Z - `mixed_owner_changed` (run 35614192763)

The mixed-owner witness `current()` pinned, per retained manager, the exact
array returned by `captureDrainedF06Originals()` (by identity), the
`tournamentSeatMoveAuthorityRevision` integer and the
`tournamentSeatMoveSerialTail` promise (by identity), and the preflight
awaited that serial tail.

The 8825 lease-loss pass re-runs `stopTournamentManagerIfOwned` every ~5 s
for the two retained managers (`5a387a75`, `615783bf`): 84 retries a minute
across the pair. Each retry builds a NEW frozen `drainedF06Originals` array
holding the same engines, returns null from `captureDrainedF06Originals()`
while its `teardownPromise` is set, bumps the revision and replaces the
serial tail. None of that moves custody - the managers are already stopped
and the retries are idempotent - but every one of the three witnesses was
false at the next re-check, so the checkpoint refused on every attempt.

## What is pinned now

The fleet witness pins, by object identity, every table the checkpoint
touches and nothing else:

- each captured engine (`captures`),
- each retained original selected for retirement (`exactEngines`),
- each original already retired (`retiredOriginals`), which must stay gone
  from the global map.

A pinned table that is replaced or vanishes still refuses with
`fleet_identity_changed`, naming the table and which way it moved
(`engine_replaced:` / `table_departed:` / `retired_still_present:`). The
whole-fleet size term is gone: a foreign cash table may arrive or leave.

The mixed-owner witness pins what the custody transfer actually names and
uses:

- `managerMap.get(tournamentId) === manager` (the manager object),
- `manager.tournamentId` and `manager.tournamentLeaseGeneration` as captured
  (the RPC input, the committed receipt and the readback all carry both),
- the `captureDrainedF06Originals` method identity (the bound authority
  wrapper), and its CONTENT: the same table ids and the same engine objects
  in the same order - a transient null while a stop retry is in flight is
  tolerated, a different engine behind a captured table id refuses,
- `manager.exactEngines`: every original in the manager's map, in the global
  map and in `tournamentOwnedTables` until it is retired, then absent from
  both,
- every manager map, set and the retirement slot, as before.

Not pinned any more: the originals array's identity, the seat move authority
revision and the seat move serial tail. The preflight joins the originals'
own stop queues (`presenceSave`, `seatBoundaryTail`, `teardownPromise`) and
no longer awaits the manager's serial tail, which the retry loop replaces
before it can be joined.

## Why safety is preserved

What `sealAndRetireOriginals` retires is named by `manager.tournamentId`,
`manager.tournamentLeaseGeneration` and the exact `{tableId, engine}` pairs
in `exactEngines`. The RPC input carries the first two and the receipt and
readback are required to echo them; the retirement is the synchronous CAS
`server.unregisterTournamentTableEngine(tableId, engine) === true`, which
refuses any engine but the captured one; and the local proof
`canonical(capture.current()) === canonical(local)` still pins the manager
id, move owner, engines, retained sources, map contents and reservations
through `checkRetained()` at every `checkMaintenance()`. Every one of those
is still a witness. The three dropped witnesses named state the retry loop
rewrites without touching custody, and the fleet term named tables the
checkpoint never touches.

## Tests

`tests/legacyEngineCheckpointGuard.test.ts`:

- a seat move revision bump plus a replaced serial tail during either RPC
  now PASSES;
- a lease generation change, a manager swap or a tournament id change during
  an RPC still refuses `mixed_owner_changed`, naming
  `manager.tournamentLeaseGeneration`, `managerMap.get(tournamentId)` or
  `manager.tournamentId`;
- a foreign cash table arriving during an RPC PASSES, arriving then leaving
  PASSES;
- `captureDrainedF06Originals()` returning a fresh equal-content array on
  every call PASSES; returning null transiently during an RPC PASSES; a
  different engine identity behind a captured table id refuses;
- an ORIGINAL leaving the fleet mid-checkpoint still refuses, naming it; a
  replaced original still refuses and retires nothing.

A foreign table that is present at the final native readiness check and not
natively durable still refuses `native_readiness_refused`: that gate is the
engine's own and is unchanged.
