# A committed custody transfer that never completed wedges every later run (2026-09-25)

The `registrations` comparison is cleared and it worked. At 14:05 UTC, run
36144233010 became the first release ever to get both retained managers'
custody through `fn_f06_prepare_mixed_manager_custody`:

```
5a387a75  transfer 4733a062  committed 14:05:23.397  run 36144233010-1
615783bf  transfer dc3ed248  committed 14:05:29.741  run 36144233010-1
```

Seven seconds later the same run died: `{"ok":false,"reason":"inspector
operation outcome unknown","progress":{"elapsedMs":5954,"attemptedTables":65,
"completedCalls":65,"verifiedTables":65,"stage":"mixed_custody"}}`, and
`legacy-engine-checkpoint.sh` turned that into `die` - correctly, because the
intent file already existed.

**That run's partial success is now the blocker, and it is worse than what it
replaced.** Two separate wedges, both proved from rows:

## 1. The database will refuse every later run for these two events

`smarter_private.f06_manager_custody_transfers` is `UNIQUE (tournament_id,
origin_generation)` and carries `f06_manager_transfer_immutable` on `BEFORE
DELETE OR UPDATE` plus a truncate guard, so those two rows cannot be removed,
edited, or joined by a second row for the same origin. `prepare` compares

```sql
IF FOUND AND (prior.transfer_id,prior.successor_generation,prior.local_proof,prior.canonical_proof)
  IS DISTINCT FROM (p_transfer_id,p_successor_generation,p_local,canonical) THEN
  RAISE EXCEPTION 'F06_MIXED_TRANSFER_CHANGED';
```

and `legacy-engine-checkpoint.sh` mints `transfer_id` and
`successor_generation` fresh per run (`str(uuid.uuid4())`), while `local_proof`
embeds that run's `release_checkpoint` - the stored rows carry
`run_id=36144233010-1` and `ownership_token=524f7404`. So a new run differs on
all four terms by construction. There is no pre-check that adopts an existing
transfer: `fn_f06_find_mixed_manager_custody` is called only as a READBACK
after the commit, never before it.

## 2. The live process's registry no longer matches, and only its replacement clears that

The commit loop is immediately followed by
`server.unregisterTournamentTableEngine(tableId, engine)` for all 23 originals.
The next run (36144951750, 14:14 UTC) refuses in `captureMixedOriginals`:

```
"reason":"mixed_original_registry_disagreement","stage":"preflight",
"attemptedTables":0,"completedCalls":0,"verifiedTables":0,
"checkpointOutcome":"not_started","restartAuthorized":false
```

Preflight runs before any custody RPC, so wedge 2 masks wedge 1. The mutation
lives in the 8825af51 process's memory: nothing durable records it, nothing can
undo it, and the only thing that clears it is the restart it is now blocking.
CLAUDE.md 10.86 rule 4 - the two-phase split in #5218 moved this trap one level
out rather than removing it, and this is where it landed.

**No new harm to players.** All 61 tables of both events have dealt nothing
since 2026-09-18 22:12:26; they were drained seven days ago when the lease was
lost. The 24 open seats were already open. The rest of the fleet is dealing
normally (336 hands in the 20 minutes this was measured).

## What this PR does, and what it does not

It does **not** fix either wedge. It makes wedge 2 say what it is. The
conjunction at the top of `captureMixedOriginals` refused as seven facts at
once, with no table and no condition anywhere in the receipt, so the receipt
could not distinguish "a previous attempt already unregistered this original"
(absent from the global map, present in its manager - recoverable only by
replacing the process) from "this original was re-seated" (the other way
round). It now refuses through the existing `witness` helper, naming the table,
the tournament, and which of the seven facts is false, with the six map
readings beside it. Observability only: the same sub-expressions in the same
order, the same code, on a path already throwing.

Pinned in `tests/legacyEngineCheckpointGuard.test.ts`: an original a previous
attempt unregistered globally is named as `registry.global_table_map` with
`globalPresent=false`, an original the map holds under a different engine is
named as the same check with `globalPresent=true`, and neither asks the
database anything.

## The fix the next run needs, in three parts that must land together

A partial ship gains nothing here - fix either wedge alone and the release
meets the other.

1. **DB, `fn_f06_prepare_mixed_manager_custody`:** a prior row for
   `(tournament_id, origin_generation)` with **no** row in
   `f06_manager_custody_completions`, whose `canonical_proof` equals the
   freshly computed `canonical`, and whose `local_proof` differs from the new
   one _only_ inside `release_checkpoint`, is work already done by a run that
   died. Adopt it and return it as the receipt. Every other difference still
   refuses. Changing this function moves `fn_f06_mixed_custody_contract()`, so
   `MIXED_CUSTODY_CONTRACT` in `server/scripts/engine-release-database-proof.py`
   and `tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json`
   move in the same commit or the checkpoint dies before the intent write.
2. **Guard, `captureMixedOriginals`:** an original absent from the global map
   whose transfer row is committed and uncompleted is not a disagreement. Prove
   that state from the row plus the manager's own maps and continue - the same
   shape as #5035's `continueAbandonedNoStartPark`, one layer out.
3. **Guard, the commit phase:** use the adopted receipt's `transfer_id` and
   `successor_generation` for the admit and complete calls instead of the
   freshly minted intent ids.

The guard is `cat`'d into the container from `CONTROL_DIR` at release time and
is not hash-pinned, so parts 2 and 3 take effect on the next attempt without a
cutover. That is what makes the circle breakable from the repo side.

## Also true, and separate

`legacy-engine-checkpoint.sh` reaches `defer` (75) only ABOVE the O_EXCL intent
write; every guard refusal below it is `die`. So a preflight refusal that
provably did not act - `attemptedTables: 0, completedCalls: 0,
checkpointOutcome: not_started`, which is exactly what 36144951750 reported -
still ends the operation instead of waiting for the next window. Worth its own
change; not this one.
