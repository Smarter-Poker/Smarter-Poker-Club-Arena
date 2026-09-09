# Lease-heartbeat lock cutover

This is the only supported production path for
`lease_heartbeats_do_not_starve_behind_live_transactions`. It is a root-cause,
stopped-engine schema cutover. It does not add a retry daemon, cron, watchlist,
lease redrive, or longer expiry window.

## Why this exists

The exact hand and tournament-manager transactions hold their lease row until
commit. Their historical `FOR SHARE` lock conflicts with the heartbeat's
`FOR NO KEY UPDATE` lock. A busy multi-table event can therefore keep its own
heartbeat classified as `busy` for an entire proof window, after which the
healthy manager fences itself and destroys every child table.

The migration makes `(id, instance_id, lease_generation)` a real non-partial
unique key on each lease table, then changes only the four surviving
transaction fences to `FOR KEY SHARE`. PostgreSQL can then renew
`heartbeat_at` concurrently, while a generation/owner change and an exact
release still require the conflicting `FOR UPDATE` lock.

## Non-negotiable order

Production is currently Stage A. The strict Stage-B migration intentionally
drops the legacy capacity bridge and both rolling hand-settlement doors. Apply
and byte-seal these boundaries in this exact order, inside one continuously
held maintenance freeze while the engine remains stopped:

1. `terminal_tournaments_cannot_reenter_a_break`
2. `precertify_stage_a_atomic_tournament_finishes`
3. `tournament_manager_request_fencing_is_strict`
4. `hand_settlement_requires_exact_seat_generation`
5. `tournament_seat_moves_are_one_atomic_receipt`
6. `lease_heartbeats_do_not_starve_behind_live_transactions`

The terminal migration first records and clears every historical terminal-break
preimage, installs the permanent terminal shape guard, and makes the completion
certificate candidate-aware without weakening the ordinary readiness RPC. The
precertification migration then evaluates the finite Stage-A completion cohort
under frozen evidence locks and fills only empty fields on already-existing
immutable finish claims. It never creates a claim or moves money. Stage B only
checks that no candidate remains while its trigger locks are held; the 5,661-row
proof is not part of Stage B's 30-second DDL transaction.

The sixth migration refuses while either Stage-A/rolling settlement door is
still installed. Do not patch the six Stage-A locks in place: doing so would
invalidate Stage B's exact source precondition and leave a mixed protocol.

## Preflight

From the reviewed, still-unmerged release branch:

```sh
scripts/dev/probe-tournament-manager-fencing-pg17.sh
scripts/dev/probe-lease-heartbeat-keyshare-pg17.sh
scripts/dev/probe-terminal-tournament-break-pg17.sh
scripts/dev/probe-stage-a-atomic-finish-precertification-pg17.sh
cd server
npx vitest run src/services/LeaseHeartbeatKeyShare.guard.test.ts \
  src/tournament/TournamentFinishCertificate.law.test.ts \
  src/tournament/TournamentBreakLifecycleFence.test.ts
npx tsc --noEmit
```

The lock probe must print five `LEASE_KEYSHARE_CASE_OK` receipts and one
`LEASE_HEARTBEAT_KEYSHARE_PG17_OK`. It proves, on PostgreSQL 17, that every
effective function allows an exact heartbeat inside 800 ms, blocks an owner or
generation replacement and `DELETE` with SQLSTATE `55P03`, then admits both
after the fenced transaction commits. It also proves Stage-A application is
rejected without leaving either ownership constraint behind.

Resolve the staged-or-promoted artifact by suffix and require a pristine
migration name:

```sh
source scripts/ops/lib/resolve-staged-or-promoted-migration.sh
KEYSHARE_FILE="$(resolve_staged_or_promoted_migration \
  "$PWD/supabase/migrations" \
  lease_heartbeats_do_not_starve_behind_live_transactions)"
scripts/ops/verify-migration-ledger-artifact.sh \
  lease_heartbeats_do_not_starve_behind_live_transactions PREAPPLY
```

## Scale authority to zero

Use the natural enforced maintenance break and the host sequence in
`tournament-fractional-stack-cutover.md`: acquire
`/var/lock/club-arena-engine-up.lock`, stop the supervisor timer and service,
gracefully stop the sole engine container, wait 30 seconds, and require the
checked-in zero-authority proof to show no fresh leader, table, or tournament
lease. A live process, active deployment, unexpected relation lock, missing
graceful shutdown receipt, or mismatched image SHA aborts the cutover.

## Apply and verify

Resolve every artifact by its stable suffix and confirm the final assigned
versions preserve the six-item order above. The branch-local Stage-B numeric
prefix is a placeholder; a normal filename-ordered migration runner must not be
allowed to place it before the newer terminal/precertification boundaries.
Apply each missing boundary exactly once through Supabase `apply_migration`.
Before any retry after a timeout or lost response, query the ledger: an
uncertain write is never replayed speculatively. Apply the key-share artifact
only after the terminal guard, precertification, Stage B and its two contractions
have unique byte-matched receipts.

Immediately after the key-share apply, require:

- exactly one ledger row and one stored statement byte-equal to
  `KEYSHARE_FILE`;
- valid, ready, immediate, non-partial, non-expression unique constraints with
  exactly the three ordered ownership columns on both lease tables;
- no Stage-A capacity bridge, nine-argument settlement door, or eleven-argument
  settlement door;
- `FOR KEY SHARE` in both lease alternatives of the private settlement core,
  the unbound add-on resolver, empty-table close, and the private manager hook;
- no surviving lease-row `FOR SHARE`, while ordinary tournament/table/seat
  parent locks remain unchanged; and
- unchanged function owner, ACL, `SECURITY DEFINER`, and per-function
  configuration.

Restart the same exact pre-cutover image under the still-held host lock, prove
its local and public SHA, restore the supervisor timer, and release the lock.
Across at least three heartbeat proof windows, require hands and next-hand
timestamps to advance and require zero active-manager `busy` expiry,
`tournament_lease_proof_expired`, or child `tournament_lease_lost` teardown.
Inspect at least one cash table, multi-table tournament, Sit & Go, and Spin.

## Seal and publish

Rename the pending artifact to the exact Supabase-assigned 14-digit version
without changing a byte. Verify it against the ledger, commit the source seal,
push, merge, and wait for every required workflow. Completion requires the
served engine image SHA (and World Hub `build-info.json` if the client bundle
changed) to equal the merged release SHA. A healthy old image, open PR, or
running workflow is not publication.

Rollback after commit is a reviewed forward migration. Never delete the
ledger row, drop the ownership constraints ad hoc, or restore `FOR SHARE` in a
live function.
