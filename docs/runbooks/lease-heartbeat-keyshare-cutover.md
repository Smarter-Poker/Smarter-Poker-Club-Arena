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

The reviewed production prerequisite tail now ends at `20260911112409`. Before
the first Stage-B DDL, and again at entry and exit of the final contraction,
require these exact one-statement ledger receipts:

- `20260910190537_late_entry_uses_canonical_capacity_and_charged_wallet_receip`:
  production ledger statement 9,097 bytes, SHA-256
  `a4e7bf3d2f352c8d12030ea83fd3697054ac3045e4276293362b6d72e2040ed4`;
- `20260911050554_final_deal_receipts_survive_real_terminal_settlement`:
  82,770 bytes, SHA-256
  `b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871`;
- `20260911052216_the_daily_free_spin_leaves_the_building`: 49,343 bytes,
  SHA-256
  `4778ce9d373a98e8b10cb31e496bf18e4e527c0a158f37a4e4fcf500b3c9b995`;
- `20260911052648_bounty_rebuy_settles_its_exact_prior_entry_generation`:
  22,463 bytes, SHA-256
  `4f9616b84906a7479c60dd0a266c2c2d1bb056828aa53ef45095ea31d058c5e2`;
- `20260911061449_the_welcome_spin_answers_the_same_everywhere`: 45,362 bytes,
  SHA-256
  `3d6efc9bc8f00e5e9840ed09d806ea9fa3d8513117a8acb8f7580d56443f4cc1`;
- `20260911061723_cancel_unstarted_entries_to_their_exact_funded_origin_wallet`:
  16,739 bytes, SHA-256
  `84f2d79130e27bd687c848a45bb65bf5b63ac2ebf0d4e9bf360dc1ec19cd284a`;
- `20260911062048_a_bust_is_ranked_by_when_it_happened`: 150,688 bytes,
  SHA-256
  `d2d0acba73031ed8617a243840eecea0e0e227a6dce5a78ce3ce2bfcfb79cf73`;
- `20260911062053_the_operator_sees_the_money_and_the_room`: 22,888 bytes,
  SHA-256
  `3f01c9da1e26451d8d8a938e1b942f70f2bdcff4db7a96e452210c5632d07648`;
- `20260911064427_the_player_can_see_the_day_and_the_way_out`: 20,833 bytes,
  SHA-256
  `9a5109e118fd3877b816126652b3e5ac0f8b54780d2dc6b37be33e61cd4b0bc6`;
- `20260911072424_the_mint_that_is_gone_stops_being_reported`: 22,537 bytes,
  SHA-256
  `a12119f40903928cf8febcca78f10b34a5b44cd8be6a996ccc68dd9c0dc69ecc`;
- `20260911072837_legacy_rakeback_closed_period_single_payer`: 36,786 bytes,
  SHA-256
  `a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7`.
- `20260911081721_legacy_round3_preserve_server_only_acl`: 3,849 bytes,
  SHA-256
  `da06b3acca81a28a54e1354932aab87d515bc3202b4922e9cccc8e1971e867d5`;
- `20260911081910_a_seat_exit_guard_without_its_consumer_refuses_nothing`:
  7,525 bytes, SHA-256
  `a1a762df5c6e9e62b63d1602a360a7349c087d652c00e22c63dac481a953a623`;
- `20260911090347_the_prize_reprice_door_the_engine_calls_exists`: 9,372 bytes,
  SHA-256
  `e528b35403f6e439287b14c54b0c7308b186d0455bf9a1198b661d26e97e2d8a`;
- `20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in`:
  17,270 bytes, SHA-256
  `0d620bf6061213e0ef0362126fde1e3e2feddc7b13720fa74727ad80da5fd570`;
- `20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses`:
  7,971 bytes, SHA-256
  `fcbbe600573494b1402cb2c10d8179534d1845ace630a921e25c5df68f589b33`;
- `20260911112409_persist_eligible_free_buy_creation_options`: 3,281 bytes,
  SHA-256
  `e16b3a057460833cd74c7a2da612df8b2c5269e156a7cc7b8116679d7fb6b24a`.

The bounded zero-data donor predates the final four receipts above. The PG17
rehearsal keeps its original `66 / 15 / 38 / 41` donor gates, normalizes one
disposable clone, then applies and records those four byte-exact sources in
their observed production-apply order before creating any Stage-B scenario.
They are current production preimage, not a seventh through tenth Stage-B
write; the six-file production cutover never reapplies them.

The Round3 receipt only restates the already server-only ACL and does not touch
any Stage-B authority. The seat-exit receipt changes the Stage-B boundary #1
preimage of `fn_ca_close_tournament_seat_exit_authority` to source MD5
`319441969e49923b3ee8d65f8f0b1e82`; boundary #1 pins that exact body. Once
Stage-B installs the seat-exit consumer trigger, the conditional guard and the
final contracted guard have the same enforced-consumption behavior.

The `20260910190537` receipt is carried unchanged. The final contraction
authenticates its canonical capacity writer, late-seat delegate and charged-
wallet ledger writer at entry and exit; it must never reinstall the retired
bespoke late-registration table creator. The tracked migration artifact is
9,098 bytes with SHA-256
`e7d8e53de468e504d4c22c1ed9f701f22cb3adb3a3fdafda3ab2dbe5dadec5ed`;
the production migration API normalized only its final newline when storing
the 9,097-byte ledger statement above. Both forms are pinned so content drift
cannot be mistaken for that one-byte transport normalization.

The `20260911090347` receipt is also carried unchanged. Its prize-repricing
door uses the tournament-scoped settlement lane; Stage B authenticates that
exact live source and service-only ACL at both contraction boundaries instead
of re-emitting the older global-lane body.

The `20260911061723` receipt authenticates the exact live preimage; it does not
approve its cash-all cancellation policy as the Stage-B postimage. Boundary #1
accepts only atomic cancellation source MD5
`623100aa87ed6d0ef1a3598fb9ccb8b3` and cancellation verifier source MD5
`0b6abcc8e4bb561856699e5d24a86fc9`, then hard-forwards them to source MD5
`16ea7acbbf76613a0a1193dff18f1330` and
`1e4c6d2f87ac2068455dbff2ace3fb2e`, respectively. The restored policy sends
cash only for `wallet_charge` entitlements to their exact recorded source
wallet; `satellite_seat` and `tournament_ticket` entitlements return as tickets
and create no wallet chips. Any other preimage aborts before Stage-B DDL, and
the final contraction must carry both restored sources unchanged.

The chain deliberately composes the final-deal completion guard from source
MD5 `d994347e1b76c936ce13361d73f94fd2` to
`8e0d121a711f6b7afade68125d032f8d` by replacing only its readiness call site.
It otherwise preserves the final-deal wrapper and payer catalogs, the complete
welcome-wheel catalog fingerprint, and the public/private bounty-rebuy pair
plus the exact `ca_settle_sources.fn_collect_bounty` live-tail note (`Exact-generation fixed and PKO bounty payer used by the atomic live authority.`). The disposable PG17
rehearsal runs the exact 42,772-byte bounty-rebuy atomicity probe after all six
boundaries; its SHA-256 is
`ef8e7fe7c0705ad265dab8f416485302b379437ab94f055f08c98e5cff3a6a5e`.
It then executes three rollback-contained exact-origin probes against that same
postimage: request-bound cross-club wallet-charge unregistration (14,986 bytes,
`a21100a43e73cbf0398e980475bd2a6d602d8245cad821204206de13576383c1`),
satellite-seat and redeemed-ticket return/replay (35,058 bytes,
`ed7f2d925a2971a89bb4e88efd5250ccfc2b3b813bd8adb6dca9c3f182e1b1ad`),
and durable-start/launch-receipt/persisted-hand refusal (21,504 bytes,
`f9025d6c48ae00e88bca43a41f854b5766d25f596150379d445a532722ab4507`).
The same post-six databases also execute the 28,071-byte exact-hand
elimination/scoped-seat-exit proof, SHA-256
`94ef8f10cdcb6ea084bcdfb4f8d5ff63db9c0271485e02f7a38ffc3d3ce5fd8f`.

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

Resolve the staged-or-promoted key-share artifact and retain the exact ordered
set used by the single pre-apply gate below:

```bash
set -euo pipefail
source scripts/ops/lib/resolve-staged-or-promoted-migration.sh
KEYSHARE_FILE="$(resolve_staged_or_promoted_migration \
  "$PWD/supabase/migrations" \
  stage_b_lease_keyshare_once)"

STAGE_B_MIGRATIONS=(
  stage_b_forward_authority_expansion
  stage_b_exact_precondition_repairs
  stage_b_terminal_break_invariant
  stage_b_atomic_finish_precertification
  stage_b_current_postimage_contraction
  stage_b_lease_keyshare_once
)
```

From the authenticated control shell, refuse to enter the host while any
engine deployment can still reach the cutover. An API error, non-numeric
answer, or any non-completed run aborts:

```bash
set -euo pipefail
DEPLOY_REPO=Smarter-Poker/Smarter-Poker-Club-Arena
for run_status in queued in_progress waiting pending requested; do
  run_count="$(gh api \
    "repos/$DEPLOY_REPO/actions/workflows/auto-deploy-hetzner.yml/runs?status=$run_status&per_page=1" \
    --jq '.total_count')"
  [[ "$run_count" =~ ^[0-9]+$ ]] && (( run_count == 0 )) || {
    echo "engine deployment state is not empty: $run_status=${run_count:-unreadable}" >&2
    exit 75
  }
done
```

## Scale authority to zero

Use the natural enforced maintenance break. Keep one root shell on the engine
host for the entire stop, apply, and restart sequence. Acquire the canonical
engine-up lock before stopping any authority:

```bash
set -euo pipefail

CONTROL=/usr/local/lib/club-arena/engine-control/engine-release-seal.py
FULL_SHA="$($CONTROL get desired-sha)"
SEALED_IMAGE_ID="$($CONTROL get desired-image-id)"
[[ "$FULL_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$SEALED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]
SHA8="${FULL_SHA:0:8}"

test "$(docker ps -q --filter label=sp.role=engine | wc -l | tr -d ' ')" -eq 1
ENGINE_CID="$(docker inspect -f '{{.Id}}' club-arena-engine)"
test "$(docker inspect -f '{{.State.Status}}' "$ENGINE_CID")" = running
test "$(docker inspect -f '{{.Image}}' "$ENGINE_CID")" = "$SEALED_IMAGE_ID"
test "$(docker inspect -f '{{index .Config.Labels "sp.release.sha"}}' "$ENGINE_CID")" = "$FULL_SHA"
test "$(docker image inspect -f '{{.Id}}' "club-arena-engine:$FULL_SHA")" = "$SEALED_IMAGE_ID"
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$SEALED_IMAGE_ID")" = "$FULL_SHA"
LIVE_HEALTH="$(curl -fsS --max-time 10 http://127.0.0.1:8080/health)"
printf '%s' "$LIVE_HEALTH" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("running") is True and d.get("version")==sys.argv[1] else 65)' \
  "$SHA8"

exec 9>/var/lock/club-arena-engine-up.lock
if ! flock -n 9; then
  echo 'engine-up lock is already owned; aborting before any authority is stopped' >&2
  exec 9>&-
  exit 1
fi
systemctl stop club-arena-supervisor.timer
systemctl stop club-arena-supervisor.service
docker stop -t 15 sp-autoheal
STOP_EPOCH="$(date +%s)"
docker stop -t 45 club-arena-engine
```

Require every stopped-state readback in that same shell:

```bash
set -euo pipefail
test "$(systemctl show -p ActiveState --value club-arena-supervisor.timer)" = inactive
test "$(systemctl show -p ActiveState --value club-arena-supervisor.service)" = inactive
test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = exited
test "$(docker inspect -f '{{.Id}}' club-arena-engine)" = "$ENGINE_CID"
test "$(docker inspect -f '{{.State.Status}}' "$ENGINE_CID")" = exited
test "$(docker inspect -f '{{.State.ExitCode}}' "$ENGINE_CID")" -eq 0
test "$(docker inspect -f '{{.State.OOMKilled}}' "$ENGINE_CID")" = false
test -z "$(docker inspect -f '{{.State.Error}}' "$ENGINE_CID")"
test "$(docker ps -q --filter label=sp.role=engine | wc -l | tr -d ' ')" -eq 0
command -v ss >/dev/null 2>&1
test -z "$(ss -H -ltn 'sport = :8080')"
if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo 'engine health endpoint still answers after the stop' >&2
  exit 65
fi
test "$(docker logs --since "$STOP_EPOCH" "$ENGINE_CID" 2>&1 | \
  grep -Fc '[GameServer] Shutdown complete.')" -eq 1
```

After 30 seconds, run the checked-in read-only proof with the exact deployed
eight-character engine SHA:

```sh
scripts/ops/verify-stage-b-zero-authority.sh "$SHA8"
```

This verifier proves only the enforced database break and zero fresh leader,
table, or tournament lease. It does not inspect GitHub runs, host processes,
container exit state, shutdown logs, or image identity; the separate gates
above prove those conditions and abort independently.

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

Immediately before the first DDL, rerun all six pristine-name gates in the
still-stopped maintenance shell so a change since preflight fails closed:

```bash
set -euo pipefail
for migration in "${STAGE_B_MIGRATIONS[@]}"; do
  scripts/ops/verify-migration-ledger-artifact.sh "$migration" PREAPPLY
done
```

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

```bash
set -euo pipefail

test "$($CONTROL get desired-sha)" = "$FULL_SHA"
test "$($CONTROL get desired-image-id)" = "$SEALED_IMAGE_ID"
test "$(docker image inspect -f '{{.Id}}' "club-arena-engine:$FULL_SHA")" = "$SEALED_IMAGE_ID"
ENGINE_UP_LOCK_HELD=1 IMAGE="club-arena-engine:$FULL_SHA" \
  /usr/local/lib/club-arena/engine-control/engine-up.sh

test "$(docker inspect -f '{{.Image}}' club-arena-engine)" = "$SEALED_IMAGE_ID"
test "$(docker inspect -f '{{index .Config.Labels "sp.release.sha"}}' club-arena-engine)" = "$FULL_SHA"

exact_engine_health() {
  local url="$1" body
  body="$(curl -fsS --max-time 10 "$url")" || return 1
  printf '%s' "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
e = d.get("equityWorkerPool")
ok = (
    d.get("status") == "ok"
    and d.get("running") is True
    and d.get("version") == sys.argv[1]
    and isinstance(e, dict)
    and e.get("phase") == "ready"
    and isinstance(e.get("configuredWorkers"), int)
    and e.get("configuredWorkers") > 0
    and e.get("readyWorkers") == e.get("configuredWorkers")
)
sys.exit(0 if ok else 65)
' "$SHA8"
}

EXACT_HEALTH_READY=0
for _attempt in $(seq 1 90); do
  if exact_engine_health http://127.0.0.1:8080/health \
     && exact_engine_health https://engine.smarter.poker/health; then
    EXACT_HEALTH_READY=1
    break
  fi
  sleep 2
done
test "$EXACT_HEALTH_READY" -eq 1

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
