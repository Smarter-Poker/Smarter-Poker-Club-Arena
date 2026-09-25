# A sealed custody transfer is not transferred twice (2026-09-25)

Engine release run 36144233010 (target `c3e8d3fe`, the 14:05Z recovery
window) ran the legacy 8825 checkpoint guard inside the live engine. It
bank-checkpointed 65 tables, entered stage `mixed_custody`, and the publisher
gave up on it:

```
{"ok":false,"reason":"inspector operation outcome unknown",
 "progress":{"elapsedMs":5954,"attemptedTables":65,"completedCalls":65,
             "verifiedTables":65,"stage":"mixed_custody"}}
```

The guard did not give up. It went on inside the engine and finished the
work: both custody transfers are committed - Noon `5a387a75` (transfer
`4733a062`, origin generation `66291622`, 14:05:23Z) and Afternoon `615783bf`
(transfer `dc3ed248`, origin generation `b3d06bad`, 14:05:29Z) are in
`smarter_private.f06_manager_custody_transfers` - and both originals were
retired through `unregisterTournamentTableEngine`. `/health.maintenance`
went from `{f06_preparation_unresolved: 1}` to `unparkedReasons: {}`,
`unparkedTables: 0`. The engine is restart-ready.

## Why the next release would have died at the checkpoint anyway

`engine-release-transaction.sh` requires the legacy checkpoint again on every
release while the sealed predecessor is 8825 (the bank checkpoint must be
fresh at restart time), and `legacy-engine-checkpoint.sh` writes a fresh
intent per `RUN_ID` - a NEW `transfer_id` and `successor_generation` per
manager. What that next run meets in-process, from the 8825 source:

- `unregisterOwnedTournamentTableEngine` deletes from `GameServer.tableEngines`
  and `tournamentOwnedTables` only (`TournamentManagerOwnership.ts:60-72`).
  The manager's own `tableEngines`, `retainedTournamentBreakSources` and
  `drainedF06Originals` are untouched: the delete in the manager's stop path
  (`TournamentManagerBase.ts:5836-5839`) sits after the
  `retained an unresolved seat-move UUID` throw (`:5813-5832`), which is what
  the stop retry hits every ~5 s. `captureDrainedF06Originals()` therefore
  still answers the same engines (`:266-291`), and a failed
  `stopOwnedTournamentManager` keeps the manager in `tournamentEngines`
  (`TournamentManagerOwnership.ts:86-101`).
- `unparkedTables` walks `GameServer.tableEngines` (`MaintenanceBreak.ts:1768`,
  `GameServer.ts:2673`): the retired originals are no longer in it, so the
  preparation count is 0. 8825 has no `mixedF06PreparationBlockers` or
  `enginesIncludingMixedF06Custody`; those belong to the replacement engine.

So `captureMixedOriginals` passes `mixed_manager_identity` and
`mixed_manager_not_drained`, then refuses `mixed_original_registry_disagreement`
at `tableMap.get(tableId) === engine` before any RPC - and had it not, the
observe call would have refused `F06_MIXED_TRANSFER_CHANGED` (migration
`20260921155216` L181-182: the prior row's `(transfer_id, successor_generation,
local_proof, canonical_proof)` must equal the call's, and the intent's ids are
new). Every future release would die at a checkpoint whose work is done. That
is the forever block one level up (CLAUDE.md 10.86 rule 4), made by the guard.

## The fix: the rows are asked first

`legacy-engine-checkpoint-guard.mjs`, per retained manager and BEFORE any
prepare call, reads `fn_f06_find_mixed_manager_custody({p_tournament_id})`:

- **no receipt, or a receipt for another origin generation** - not this
  manager's seal. The full path runs exactly as before, every check intact;
  a stale row for this tournament still meets the database's own
  `F06_MIXED_TRANSFER_CHANGED` on the observe call.
- **a receipt for this manager's lease generation whose `local_proof` names
  this exact process** (`release_checkpoint.kind/source/instance_id/
container_id/process_id`) **and this exact manager** (`manager_id`) - a
  transfer this guard already sealed. The manager is `sealed`: no observe, no
  commit, no readback; the intent's fresh ids for it are simply unused; its
  originals are not required to be registered or drained (they were retired),
  and `captureDrainedF06Originals()`, `mixed_manager_not_drained` and the
  receipt checks are never asked of it. An original the row names that is
  gone from the global map (and, as 8825 deletes both together, from the owned
  set) is recorded as retired and pinned absent for the rest of the run.
- **a receipt for this generation naming another process or manager** refuses
  `mixed_sealed_transfer_foreign`, naming the sub-condition, before any
  prepare.
- **a lookup that did not come back, or came back malformed**, decides
  nothing: the manager stays on the existing path, exactly as if the lookup
  had found no row. The lookup precedes a path that already carries every
  refusal it needs, and the observe call still meets the database's own
  `F06_MIXED_TRANSFER_CHANGED` against any transfer this run did not make; a
  read made ahead of that path must not be able to add a refusal of its own
  (`EngineLifecycleDiagnostics.test.ts` runs the guard against fixtures that
  never answer the find, and names the drain refusals that follow it). What
  the lookup answered for each manager travels as `sealedLookup`
  (`5a387a75:sealed 615783bf:none`, or `unanswered`, `malformed`,
  `other_generation`); nothing reads it.

**A sealed manager whose original is STILL registered** - the shape a run cut
off between its commit and its CAS would leave - is retired through the same
synchronous identity CAS, and only for the exact stopped, terminal engine the
row names (`engine_id`), still held by this manager under the same table id,
while the same manager still owns the same generation
(`mixed_sealed_owner_changed` otherwise). This is the safe choice, not the
lenient one: the row already holds the custody and is immutable, so retiring
the object is finishing that run's own last step, whereas refusing would hold
8825's `readyForRestart()` false for ever on a table whose custody is already
gone. A different engine behind the table id, an engine that runs again, a
table gone from the map but still marked owned, or an engine the manager
holds that the row never named each refuse (`mixed_sealed_original_registry_
disagreement`, `mixed_sealed_original_unnamed`) and retire nothing.

The bank checkpoint stage, `proveAbandonedBoundaries`, `verifyFiles` and the
final readiness certificate run unchanged. The result carries
`sealedManagers` (a count; `legacy-engine-checkpoint.mjs` carries it like every
other count and drops it from a guard that predates it). Nothing in the lookup
writes, and no production write beyond the CAS the guard already made exists.

## Tests

`tests/legacyEngineCheckpointGuard.test.ts`, "a sealed custody transfer is not
transferred twice": both managers sealed (as 8825 leaves the manager maps, and
with them emptied and the drain capture answering null) - one lookup per
manager, no prepare, rows unchanged, `sealedManagers: 2`, readiness certified;
one sealed and one not - the unsealed manager still goes observe, commit,
readback, CAS with the new ids and the sealed one is never prepared; a row for
a different origin generation takes the full path and meets
`F06_MIXED_TRANSFER_CHANGED`; a row for this generation naming another
container, instance, manager or no checkpoint refuses named, before any
prepare; an errored, thrown or malformed lookup takes the full path unchanged
and does not hide a drain refusal; a still-registered exact original
is retired by the CAS; a replaced, running, or owned-but-absent one refuses.
The fixture keeps the seal lookups (`probes`) apart from the custody transfer
calls (`rpcCalls`), so "transfers nothing, retires nothing" keeps meaning that.
