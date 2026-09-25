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

## Addendum, later the same day: the guard does not checkpoint an engine that never started

The two witnesses above stopped pinning the churning table, but the
snapshot still CAPTURED it. `entries = [...tableMap.entries()]` is taken
once at preflight and every entry goes through `captureEngine`; when
`3c00d4d0-5d98-44de-ad36-cd683001d32a` was in the map at that instant it was
pinned like any other capture, and its scheduled kill and removal a second
later refused the checkpoint (`fleet_identity_changed` /
`table_departed:` from `checkMaintenance()`, or `engine_identity_changed`
from `checkEngine()`, whichever ran first). The transaction allows one
attempt per countdown, and the table is in the map for a good part of every
cycle, so this was a coin flip on every hour.

### The cycle, from the host log (2026-09-21, UTC; read-only `docker logs`)

```
16:25:52.354 [GameServer] Starting engine for cash table 3c00d4d0-... (6 seated, 0 human)
16:25:52.609 [ServerTableEngine] Created for table 3c00d4d0-...
16:25:52.609 [ServerTableEngine:3c00d4d0-...] Starting...
16:25:52.919 [ServerTableEngine:3c00d4d0-...] Last persisted hand on this table: #13062928
16:25:53.030 [ServerTableEngine:3c00d4d0-...] Button restored to seat 4 from the last settled hand
16:25:53.151 [ServerTableEngine.3c00d4d0-....failed_to_start] Error: retained_hand_submission_pending: original_failure_or_handoff_unproven
16:25:53.151 [ServerTableEngine.3c00d4d0-....watchdog_kill] Error: Engine self-terminating for restart: start_failed:start_load_table
16:25:53.151 [ServerTableEngine:3c00d4d0-...] Stopped. Dealt 0 hands.
16:25:53.379 [lease] table 3c00d4d0-... no longer has a current missing ownership proof. Stopping it before re-admission.
16:25:54.003 [ServerTableEngine] Created for table 3c00d4d0-...
16:25:54.003 [ServerTableEngine:3c00d4d0-...] Starting...
16:25:54.502 ... failed_to_start ... watchdog_kill: start_failed:start_load_table ... Stopped. Dealt 0 hands.
16:25:55.973 Created ... 16:25:56.453 Stopped. Dealt 0 hands.
16:25:57.697 Created ... 16:25:58.158 Stopped. Dealt 0 hands.
16:25:59.405 Created ... 16:25:59.880 Stopped. Dealt 0 hands.
```

Created-to-Stopped is ~0.5 s, and a new generation follows within ~1.5 s:
the object is in `tableEngines` for roughly a quarter to a third of the
time, every second or two, without end.

### What such an object is, from the 8825 source (`git show 8825af51:...`)

`server/src/GameServer.ts`, `ensureCashTableEngineAdmission`:

```ts
const engine = new ServerTableEngine(tableId, { scope: 'cash', verified: true, generation: ..., });   // 9657
this.wireDirectTableEngineRecovery(tableId, engine);
this.tableEngines.set(tableId, engine);                                                              // 9665
...
this.maintenanceBreak.adopt(tableId, engine);                                                        // 9673  -> pauseForMaintenance(): maintenancePaused = true, holdBeforeNextHand = true
const readyPromise = this.trackDirectTableEngineReadiness(tableId, engine);
void engine.start().catch(async (startError) => { ...
    await this.recoverDirectTableEngine(tableId, engine, 'direct_start_failed', true);               // 9684
```

`server/src/engine/ServerTableEngineBase.ts`, `start()`:

```ts
this.running = true;                                   // 2960 - before the first await
...
this.setLoopPhase('start_load_table');                 // 2965
tableData = await loadTable(this.tableId);             // 2990
await this.seedHandCountFromHistory();                 // 3093 - "Last persisted hand ... #13062928": handCount is NOT zero
await this.restoreButtonFromHistory();                 // 3098 - "Button restored to seat 4"
const recovered = ... await this.checkCrashRecovery(); // 3110 -> resumeRetainedHandSubmission throws retained_hand_submission_pending (8123)
...   (loadPresenceFromPark 3130 / readParkedTimeBanks 3141 / tableFSM 'waiting' 3146 / settleReady(true) 3150 / 'start_wait_for_players' 3171 / dealingLoopPromise 3355 are never reached)
} catch (err) {
  this.settleReady(false);
  this.killForRestart('start_failed:' + this.loopPhase, false);   // 3387
  throw err;
```

`killForRestart` -> `fenceTerminalEngine` (4674-4736):

```ts
this.terminal = true;            // 4711
this.running = false;            // 4712
...
this.handController = null;      // 4735
```

`recoverDirectTableEngine` -> `performDirectTableEngineRecovery`
(GameServer.ts 1660-1706): `await engine.stop()` (so `teardownPromise` is a
Promise: 3445), the exact cash lease release, then and only then
`this.tableEngines.delete(tableId)` (1706).

What the object holds while it is in the map:

| field                                                           | value                                                      | why                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `loopPhase`                                                     | `'start_load_table'` (`'not_started'` before start() runs) | 2965; next phase is set only after `waiting` (3154, 3171)                                           |
| `running` / `terminal`                                          | `true` / `false` until the kill; then `false` / `true`     | 2960; 4711-4712                                                                                     |
| `dealingLoopPromise`                                            | `null`                                                     | installed only at the end of start() (3355)                                                         |
| `handsDealtThisSession`                                         | `0` ("Dealt 0 hands")                                      | incremented only when a hand is dealt (ServerTableEngineDealing.ts:1833)                            |
| `handCount`                                                     | seeded, `13062928`                                         | 3093 - NOT a "never dealt" witness                                                                  |
| `seatedPlayers`                                                 | `[]`                                                       | filled only by `adoptSeatRoster` from the wait-for-players loop (3217, 4259)                        |
| `timeBankEngine.playerBanks`, `timeBankMeta`, `parkedTimeBanks` | empty                                                      | banks are created per occupancy at the first hand; the park is read at 3141, after the failing call |
| presence FSM states                                             | `{}`                                                       | `loadPresenceFromPark` at 3130 is after the failing call                                            |
| `handController`                                                | `null`                                                     | never dealt; also cleared by the fence (4740)                                                       |
| `f06MovementAdmission` / `f06CurrentPermit`                     | `null`                                                     | cash lane, no permit                                                                                |

It never loaded a seat, never created a bank, never wrote a park row of its
own beyond the `announced` row `pauseForMaintenance` queues (5143-5157),
and it is not a retained original: those are tournament-scoped, in
`tournamentOwnedTables`, and captured by `captureMixedOriginals`.

### The exclusion rule

At the snapshot, under the exact 8825 profile only, an entry is NOT captured
when ALL of the following hold (`neverStarted(tableId, engine)` in the
guard); any single false term means it is captured and pinned exactly as
before:

- `engine instanceof ServerTableEngineBase`, `engine.tableId === tableId`,
  not a retained original, `tableId` not in `server.tournamentOwnedTables`;
- `engineLeaseScope === 'cash'`, `engineLeaseVerified === true`,
  `f06MovementAdmission === null`, `f06CurrentPermit === null`,
  `f06RecoveryInFlight === false`;
- `loopPhase` is `'start_load_table'` or `'not_started'`;
- `dealingLoopPromise === null`, `handsDealtThisSession === 0`,
  `handController === null`;
- `seatedPlayers.length === 0`, `timeBankMeta.size === 0`,
  `timeBankEngine.playerBanks.size === 0`, `parkedTimeBanks` is `{}`,
  `disconnectEngine.getFsmStatesForTable(tableId)` is `{}`;
- `timeBankAccountingPending.size === 0`,
  `timeBankAccountingUnconfirmed === false`, `settlementInFlight.size === 0`,
  `postHandTasksPromise === null`, `tournamentMoveOperations.size === 0`,
  `terminalBoundaryPendingGenerations.size === 0`,
  `terminalBoundaryPersistenceFailed === false`.

A skipped table is followed, not forgotten. `checkUnstarted()` runs inside
every `checkMaintenance()` (so at every point the captured tables are
re-checked, including between checkpoint writes):

- same object still in the map: it must still satisfy the whole conjunction
  (a skipped engine that acquires a seat or a bank refuses
  `engine_state_changed`, `unstarted_acquired_custody:<table>`);
- gone from the map: tolerated only if that object is now fenced and
  stopped the way the recovery does it - `terminal === true`,
  `running === false`, `teardownPromise instanceof Promise` - and still
  satisfies the conjunction; otherwise `engine_identity_changed`,
  `unstarted_departed_unfenced:<table>`;
- a different object behind the same table id: the old one must be fenced
  as above and the successor must itself satisfy the conjunction, and the
  successor is then the one followed; otherwise `engine_identity_changed`,
  `unstarted_replaced:<table>`.

The result reports `skippedUnstarted`, `unstartedReplacements` and
`unstartedDepartures` (8825 profile only, appended after every existing
key). No write, readback or readiness check ever names a skipped table.

Not skipped, ever: a running engine that has dealt a hand this session, an
engine holding a seat, a bank, bank metadata, a parked bank or a presence
state, a tournament-scoped engine, a table in `tournamentOwnedTables`, a
retained original or a captured mixed engine, an engine past
`start_load_table`, or one with a dealing loop or a hand controller. Those
are captured and pinned as before, and their departure still refuses.

### Tests (`tests/legacyEngineCheckpointGuard.test.ts`)

- an unstarted cash engine present at the snapshot, killed and removed
  during an RPC: PASSES, `skippedUnstarted: 1`, `unstartedDepartures: 1`,
  no park write and no row for it;
- the same engine present at the snapshot and still present at the end:
  PASSES, `skippedUnstarted: 1`, its fields only read;
- the live cycle - fenced, removed, re-admitted as a new unstarted
  generation, fenced and removed again: PASSES, `unstartedReplacements: 1`,
  `unstartedDepartures: 2`;
- an unstarted engine removed WITHOUT the fence and stop: refuses
  `engine_identity_changed` (`unstarted_departed_unfenced:`);
- a skipped engine that acquires a seat and a bank mid-run: refuses
  `engine_state_changed` (`unstarted_acquired_custody:`);
- a started engine re-admitted behind a skipped table id: refuses
  `engine_identity_changed` (`unstarted_replaced:`), nothing retired;
- a STARTED engine (running, seated, banked) removed during an RPC: still
  captured, still refuses (`fleet_identity_changed`, `table_departed:`),
  `skippedUnstarted: 0`;
- an engine with `handsDealtThisSession: 1` and no seat: still captured,
  still refuses;
- a retained original carrying every unstarted flag: never skipped,
  `skippedUnstarted: 0`, its departure still refuses naming it;
- an unstarted-looking engine in `tournamentOwnedTables`: never skipped.
