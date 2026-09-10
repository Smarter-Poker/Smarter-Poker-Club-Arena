# Lease-heartbeat lock cutover

This is the only supported production path for
`stage_b_lease_keyshare_once`. It is a root-cause,
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

1. `stage_b_forward_authority_expansion`
2. `stage_b_exact_precondition_repairs`
3. `stage_b_terminal_break_invariant`
4. `stage_b_atomic_finish_precertification`
5. `stage_b_current_postimage_contraction`
6. `stage_b_lease_keyshare_once`

The exact-precondition repair first restores the current frozen preimage. The
terminal and precertification boundaries then clear and guard terminal break
state and certify only already-existing immutable finish claims. The current
postimage contraction composes the manager fence, exact-generation settlement,
DB-first seat move, and current tournament authorities in one reviewed source.
It never replays the archived incident migrations individually.

The sixth migration refuses while either Stage-A/rolling settlement door is
still installed. Do not patch the six Stage-A locks in place: doing so would
invalidate Stage B's exact source precondition and leave a mixed protocol.

Production migration `20260909234808_restore_exact_hand_generation_after_terminal_writer`
is an already-applied prerequisite, not a seventh cutover write. Before taking
the host lock, require its unique one-statement ledger receipt and require the
live seven- and twelve-argument settlement definitions to be
`9be5d1da12d8f674a47a50ffb9a6df81` and
`f93a85ebe5a509ccb7dfedb9be1ed3fa`. Stage B pins those bytes before
retiring either rolling door, and the immediately following strict contraction
preserves terminal receipts while removing the legacy payload fallback.

## Preflight

From the reviewed, still-unmerged release branch:

```sh
scripts/dev/probe-stage-b-forward-chain-pg17.sh --resolve-only
scripts/dev/probe-lease-heartbeat-keyshare-pg17.sh
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
  stage_b_lease_keyshare_once)"
scripts/ops/verify-migration-ledger-artifact.sh \
  stage_b_lease_keyshare_once PREAPPLY
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
