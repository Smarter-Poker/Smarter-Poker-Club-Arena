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
current composed Stage-A settlement catalog to match all four hashes below:

- seven-argument `fn_ca_settle_hand_stacks_absolute`: definition MD5
  `a7f5dbcd26c3a19f16ecc2ebe010b1d1`, source MD5
  `e67e89b3aec325f8038e0507a1511eec`;
- twelve-argument `fn_ca_commit_hand_settlement`: definition MD5
  `a1738adaf943656868e68a7bf7ce8d1e`, source MD5
  `0ef3c57a6a31acc383ce4b95a0f9519f`.

The older `9be5d1da...` / `f93a85eb...` pair identifies the earlier restore
migration's immediate postimage, before the later seat-exit and time-bank
composition, and is not a valid current-live preflight. Stage B pins the
current composed catalog bytes before retiring either rolling door; its
asserted seven-argument rename changes that function's definition text (and
therefore its definition MD5) while preserving the pinned source body. The
immediately following strict contraction preserves terminal receipts while
removing the legacy payload fallback.

The reviewed production prerequisite tail now ends at `20260911052648`. Before
the first Stage-B DDL, and again at entry and exit of the final contraction,
require these exact one-statement ledger receipts:

- `20260911050554_final_deal_receipts_survive_real_terminal_settlement`:
  82,770 bytes, SHA-256
  `b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871`;
- `20260911052216_the_daily_free_spin_leaves_the_building`: 49,343 bytes,
  SHA-256
  `4778ce9d373a98e8b10cb31e496bf18e4e527c0a158f37a4e4fcf500b3c9b995`;
- `20260911052648_bounty_rebuy_settles_its_exact_prior_entry_generation`:
  22,463 bytes, SHA-256
  `4f9616b84906a7479c60dd0a266c2c2d1bb056828aa53ef45095ea31d058c5e2`.

The chain deliberately composes the final-deal completion guard from source
MD5 `d994347e1b76c936ce13361d73f94fd2` to
`8e0d121a711f6b7afade68125d032f8d` by replacing only its readiness call site.
It otherwise preserves the final-deal wrapper and payer catalogs, the complete
welcome-wheel catalog fingerprint, and the public/private bounty-rebuy pair
plus `ca_settle_sources.fn_collect_bounty = 'DB caller'`. The disposable PG17
rehearsal runs the exact 40,468-byte bounty-rebuy atomicity probe after all six
boundaries; its SHA-256 is
`69d5392b3afbf01b0be37ad94637bec19047ef79232aafd0e0cceb6f34d4b02c`.

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

Use the natural enforced maintenance break. Keep one root shell on the engine
host for the entire stop, apply, and restart sequence. Acquire the canonical
engine-up lock before stopping any authority:

```sh
exec 9>/var/lock/club-arena-engine-up.lock
if ! flock -n 9; then
  echo 'engine-up lock is already owned; aborting before any authority is stopped' >&2
  exec 9>&-
  exit 1
fi
systemctl stop club-arena-supervisor.timer
systemctl stop club-arena-supervisor.service || true
docker stop -t 15 sp-autoheal
docker stop -t 45 club-arena-engine
```

Require every stopped-state readback in that same shell:

```sh
test "$(systemctl is-active club-arena-supervisor.timer)" = inactive
test "$(systemctl is-active club-arena-supervisor.service)" = inactive
test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = exited
test "$(docker ps -q --filter label=sp.role=engine | wc -l)" -eq 0
test "$(docker inspect -f '{{.State.Running}}' club-arena-engine)" = false
! curl -sf --max-time 3 http://127.0.0.1:8080/health
! pgrep -af 'node.*club-arena.*server|node.*dist/index' | grep -v pgrep
```

After 30 seconds, run the checked-in read-only proof with the exact deployed
eight-character engine SHA:

```sh
scripts/ops/verify-stage-b-zero-authority.sh "$SHA8"
```

It proves the enforced break and zero fresh leader, table, or tournament lease.
A live process, active deployment, unexpected relation lock, missing graceful
shutdown receipt, or mismatched image SHA aborts the cutover.

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

Restart the same exact pre-cutover image under the still-held host lock through
the canonical `ENGINE_UP_LOCK_HELD=1` engine-up path. Prove the local
`127.0.0.1:8080/health` response and public health both serve that exact SHA,
then start and prove `sp-autoheal`, start and prove the supervisor timer, and
only then release descriptor 9. Every pre-commit abort uses this same ordered
recovery sequence; a healthy engine alone is not authority-recovery proof.
Across at least three heartbeat proof windows, require hands and next-hand
timestamps to advance and require zero active-manager `busy` expiry,
`tournament_lease_proof_expired`, or child `tournament_lease_lost` teardown.
Inspect at least one cash table, multi-table tournament, Sit & Go, and Spin.

The ordered restart in the still-locked root shell is:

```sh
ENGINE_UP_LOCK_HELD=1 IMAGE="club-arena-engine:$FULL_SHA" \
  /usr/local/lib/club-arena/engine-control/engine-up.sh
curl -fsS --max-time 5 http://127.0.0.1:8080/health
curl -fsS --max-time 10 https://engine.smarter.poker/health
docker start sp-autoheal
test "$(docker inspect -f '{{.State.Running}}' sp-autoheal)" = true
systemctl start club-arena-supervisor.timer
test "$(systemctl is-active club-arena-supervisor.timer)" = active
exec 9>&-
```

## Seal and publish

Seal all six applied Stage-B artifacts named in the non-negotiable order above,
not only the final key-share artifact. For each of
`stage_b_forward_authority_expansion`, `stage_b_exact_precondition_repairs`,
`stage_b_terminal_break_invariant`, `stage_b_atomic_finish_precertification`,
`stage_b_current_postimage_contraction`, and `stage_b_lease_keyshare_once`:

1. rename its source file to the exact Supabase-assigned 14-digit ledger version
   while preserving its bytes exactly;
2. prove the pre-rename and post-rename checksums are identical and the sealed
   file is byte-equal to the stored migration statement; and
3. update every checked-in reference to the former path, including scripts,
   tests, manifests, and runbooks, then prove no stale path reference remains.

Commit and push the complete six-artifact source seal. After the PR is merged,
first verify and record its exact 40-character merge SHA. Before any workflow
wait or status poll, identify the source-owned release run for that SHA. On the
pre-authority-cutover workflow, the eligible protected-main push creates the
single `auto-deploy-hetzner.yml` receiver directly. After the release-authority
cutover, `stage-engine-release.yml` classifies the same push and delivers its
exact-SHA event to that receiver. Both routes stage the durable Hetzner host
transaction immediately.

There is no manual, scheduled, observer, or World Hub release path. An absent
or ambiguous source-owned run is a failed release that needs a reviewed source
repair, not an alternate dispatch command. Never wait for the maintenance
window or a later observer to start the release. Staging and waiting for the
protected break are separate: the release enters the train immediately, while
its receiver alone owns the bounded production window.

Completion requires the public engine health response to serve the exact merged
release SHA. If the client bundle changed, both the Club Arena origin
`https://ca-static.smarter.poker/build-info.json` and the player route
`https://smarter.poker/hub/club-arena/build-info.json` must serve that same SHA.
A healthy old image, open PR, accepted event, or running workflow is not
publication.

Rollback after commit is a reviewed forward migration. Never delete the
ledger row, drop the ownership constraints ad hoc, or restore `FOR SHARE` in a
live function.
