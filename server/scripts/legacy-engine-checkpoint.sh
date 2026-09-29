#!/usr/bin/env bash
# One first-install checkpoint inside the existing, locked release operation.
# No image replacement, maintenance override, flag assignment or retry here.
set -euo pipefail
CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REQUEST_ROOT="${ENGINE_RELEASE_REQUEST_ROOT:-/var/lib/club-arena/engine-release-requests}"
CONTAINER="${CONTAINER:-club-arena-engine}"

die() { echo "[legacy-engine-checkpoint] $*" >&2; exit 1; }
# Two refusals, not one, because conflating them is what burned every release
# on 2026-09-21. `die` (1) ends the operation for good. `defer` (75) says the
# break window closed while this entry was still running and NOTHING durable
# was created - no intent file, no inspector, no write - so the owning
# transaction may wait for a later certificate and enter again. It is only
# ever reachable ABOVE the O_EXCL intent write below. CLAUDE.md 10.86 rule 1:
# "this attempt arrived late" is a different outcome from "this attempt is
# unsafe", so it gets its own name and its own code.
defer() { echo "[legacy-engine-checkpoint] $*" >&2; exit 75; }
# BELOW the intent there is exactly ONE further deferral, and it is a different
# function on purpose so the two can never be confused or widened into each
# other. `defer` above is unconditional: it fires on a plain shell check having
# written nothing at all. `defer_proved_not_started` fires only after the guard
# has RETURNED - inspector closed, complete receipt in hand - saying in its own
# fields that it refused in preflight on a capture-then-reverify race and
# touched nothing (`deferrableCheckpointRefusal`, exit 75 from the node
# helper), AND after this script has proved the intent on disk is byte for byte
# the one THIS entry wrote and retired it. A disconnect, a partial receipt, a
# retained inspector or any other reason never reaches it; those are all `die`,
# and a retry stays forbidden however the helper exited.
defer_proved_not_started() { echo "[legacy-engine-checkpoint] $*" >&2; exit 75; }
[ "$(id -u)" = 0 ] || die 'root-owned release required'
[ "$#" = 1 ] || die 'expected owning run key'
RUN_ID="$1"
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'invalid run key'
# /var/lock is a symlink to /run/lock on the engine host. Compare the held
# descriptor's file identity, not a resolved path against its configured alias.
[ "/proc/$$/fd/9" -ef "${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}" ] \
  || die 'owning engine lock descriptor missing'
flock -n 9 || die 'owning engine lock unavailable'
mapfile -t REQUEST < "$REQUEST_ROOT/$RUN_ID.request"
[ "${#REQUEST[@]}" = 6 ] && [ "${REQUEST[3]}" = "$CONTROL_DIR" ] \
  && [ "${REQUEST[4]}" = "$(cat "$CONTROL_DIR/control-sha")" ] \
  || die 'immutable operation generation mismatch'
[ "$(date +%s)" -lt "${REQUEST[5]}" ] || die 'owning operation expired'
LEGACY_SHA="$(timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-sha)" \
  || die 'sealed predecessor unreadable'
# Closed, measured predecessor profiles. Neither a caller nor an environment
# variable can supply another source, image or compiled-code profile.
case "$LEGACY_SHA" in
  2f4e33560bcd23bfb5cc731f31816b2c2e2847e5)
    LEGACY_IMAGE=sha256:3796b874331fee7d3b0824472df65e9fe613306a5175d3a211fdf8158bdab852 ;;
  758610f3f844406bbbaee2f5100ced36d84fb943)
    LEGACY_IMAGE=sha256:0190d49e394fd2b12b1462730bb22c4c4d1c4d49564e19b192bb07e3754c5561 ;;
  a0ab287d902879280f0c915e44f5222c5db4d7df)
    LEGACY_IMAGE=sha256:a58e0d3983b73b59bfc26e0ad55f67759730a7313d0280f80311fe20109658f6 ;;
  8825af51817f379c4261658ca29ecc9d8d81932d)
    LEGACY_IMAGE=sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c ;;
  *) die 'sealed predecessor has no qualified checkpoint profile' ;;
esac
[ "$(timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-image-id)" = "$LEGACY_IMAGE" ] \
  || die 'sealed predecessor is not the qualified legacy image'
IDENTITY="$(timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}' "$CONTAINER")"
read -r CONTAINER_ID IMAGE RUNNING STARTED_AT HOST_PID <<< "$IDENTITY"
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] && [ "$IMAGE" = "$LEGACY_IMAGE" ] \
  && [ "$RUNNING" = true ] || die 'serving predecessor identity mismatch'
if [ "$LEGACY_SHA" = 8825af51817f379c4261658ca29ecc9d8d81932d ]; then
  [ "$CONTAINER_ID" = c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66 ] \
    && [ "$STARTED_AT" = 2026-09-18T21:55:50.88305198Z ] && [ "$HOST_PID" = 1231816 ] \
    || die 'original mixed-custody process changed'
fi
NODE_BOOT_STARTED_MS="$(date +%s%3N)"
timeout 3s docker exec "$CONTAINER_ID" node -e '
const fs = require("node:fs");
const args = fs.readFileSync("/proc/1/cmdline", "utf8").split("\0").filter(Boolean);
if (process.version !== "v22.23.2" ||
    JSON.stringify(args) !== JSON.stringify(["node", "dist/index.js"]) ||
    /--(?:inspect|debug)/.test(process.env.NODE_OPTIONS ?? "") ||
    process.env.GIT_COMMIT_SHA !== process.argv[1]) process.exit(1);
' "$LEGACY_SHA" || die 'predecessor runtime or loopback inspector configuration refused'
NODE_BOOT_MS=$(( $(date +%s%3N) - NODE_BOOT_STARTED_MS ))
# The guard's own boot - one durable intent write with two fsyncs and a cold
# containerised node module boot that streams the two guard files in and
# enumerates the fleet - is paid INSIDE the transaction's 40000ms legacy
# checkpoint budget (engine-release-transaction.sh, LEGACY_CHECKPOINT_BUDGET_
# SECONDS: ~15000ms of entry, 20000ms of work, 5000ms of cleanup), never
# added to the entry threshold below. The runtime check immediately above is
# its measurable proxy - same container, same node binary, same exec path -
# so it is measured here and reported, as evidence for the next re-derivation
# of that allowance, not as an admission term. (The literal invocation above
# is an anchor other suites locate with indexOf; it is not repeated here.)
echo "[legacy-engine-checkpoint] predecessor runtime check took ${NODE_BOOT_MS}ms; the guard boot it proxies is inside the 40000ms legacy checkpoint budget" >&2

# Installed SQL is a prerequisite, not a trial mutation. Refuse before the
# durable one-shot intent or inspector; the existing transaction owns failure.
if [ "$LEGACY_SHA" = 8825af51817f379c4261658ca29ecc9d8d81932d ]; then
  timeout 8s python3 "$CONTROL_DIR/engine-release-database-proof.py" \
    --env-file "${ENGINE_ENV_FILE:-/opt/club-arena/server/.env}" --sha "$LEGACY_SHA" \
    --mixed-custody-contract \
    || die 'installed mixed-custody contract unavailable or incompatible; checkpoint not started'
fi

INSTANCE="$(curl -sS --max-time 2 http://127.0.0.1:8080/health | python3 -c '
import json,re,sys
d=json.load(sys.stdin); m=d.get("maintenance",{}); instance=d.get("instanceId",""); release=sys.argv[1]
# The entry threshold is the reserve the guard holds at every check (245000,
# reserveMs in legacy-engine-checkpoint-guard.mjs) PLUS the whole 40000
# budget the checkpoint still has to pay after this probe (entry, work and
# cleanup, engine-release-transaction.sh LEGACY_CHECKPOINT_BUDGET_SECONDS):
# 285000, the same figure legacy_checkpoint_countdown admitted on. Nothing is
# ADDED to it for the boot that follows: the 300000 countdown has exactly
# 15000 above 285000 and the entry spends it, so any positive term here would
# defer at every break for ever. A break shorter than this defers (75); it
# never dies, because nothing has been written yet.
# (No apostrophes in this comment: it lives inside a single-quoted python -c
# argument, and one would close the quote and break the command substitution.)
reserve=245000+40000
ok=(d.get("running") is True and d.get("version")==release[:8] and re.fullmatch(r"1-[0-9a-f]{8}",instance)
    and (release=="2f4e33560bcd23bfb5cc731f31816b2c2e2847e5" or d.get("releaseSha")==release)
    and m.get("active") is True and m.get("phase")=="counting_down"
    and m.get("durableConfirmed") is True and m.get("remainingMs",0)>=reserve)
if not ok: raise SystemExit(1)
print(instance)
' "$LEGACY_SHA")" || defer 'the break window closed before the checkpoint could start; nothing was attempted'

# Persist intent before opening debugger access. A disconnect is unknown, not
# permission to invoke again. Existing release recovery retains this run key.
#
# THE O_EXCL BELOW IS THE ONE-SHOT AND IT IS NOT WEAKENED HERE. What changed on
# 2026-09-21 is only that its refusal has a NAME. Run 35626149078 re-entered
# this helper under the same run key after its owning transaction was
# interrupted; O_EXCL did exactly its job and the operator was shown
# `FileExistsError: [Errno 17] File exists` followed by `could not reattach to
# the durable Hetzner release transaction (1)` - a raw traceback that reads
# identically to a full disk, a permission fault or a broken interpreter.
# "This run key already opened the checkpoint" is a different outcome from
# "the write failed", so it gets its own sentence and its own code, 70
# (CLAUDE.md 10.86 rule 1). Nothing is retried, nothing is retired, and the
# guard still refuses: 70 ends the release exactly as 1 did.
set +e
CHECKPOINT_INTENT="$(python3 - "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" "$INSTANCE" "$CONTAINER_ID" "$STARTED_AT" "$HOST_PID" "$LEGACY_SHA" "$RUN_ID" "${REQUEST[4]}" <<'PY'
import json,os,sys,time,uuid
path,instance,container,started,pid,source,run,control=sys.argv[1:]
intent={"instance":instance,"container":container,"startedAt":started,"hostPid":int(pid),
        "source":source,"runId":run,"controlSha":control,"at":time.time(),"retryAllowed":False}
if source=="8825af51817f379c4261658ca29ecc9d8d81932d":
    if instance!="1-3846b8bb": raise SystemExit("original process instance changed")
    intent["custody"]=[{"tournament_id":event,"transfer_id":str(uuid.uuid4()),"successor_generation":str(uuid.uuid4())}
        for event in ["5a387a75-754a-416e-8fee-b85b15fc2702","615783bf-15e3-40b7-9368-75f21b6ac53b"]]
try:
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except FileExistsError:
    sys.stderr.write("[legacy-engine-checkpoint] the one-shot intent for this run key already exists at "+path+"\n")
    raise SystemExit(70)
try:
    os.write(fd,(json.dumps(intent)+"\n").encode())
    os.fsync(fd)
finally: os.close(fd)
fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
try: os.fsync(fd)
finally: os.close(fd)
print(json.dumps(intent,separators=(",",":")))
PY
)"
CHECKPOINT_INTENT_RC=$?
set -e
if [ "$CHECKPOINT_INTENT_RC" = 70 ]; then
  echo "[legacy-engine-checkpoint] ALREADY ENTERED: this run key opened the one-shot checkpoint before, and its durable intent is still on disk. Whether that entry acted CANNOT be read from here, so re-entering is forbidden and nothing is retried or retired. Dispatch a new run key." >&2
  exit 70
fi
[ "$CHECKPOINT_INTENT_RC" = 0 ] \
  || die 'the durable one-shot checkpoint intent could not be written; nothing was attempted'

set +e
{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs"; cat "$CONTROL_DIR/legacy-engine-checkpoint.mjs"; } \
  | docker exec -i "$CONTAINER_ID" node --input-type=module - "$INSTANCE" "$LEGACY_SHA" "$CHECKPOINT_INTENT"
CHECKPOINT_RC=$?
set -e
if [ "$CHECKPOINT_RC" = 75 ]; then
  # The guard came back, closed its inspector, and reported a capture-then-
  # reverify refusal at stage `preflight` with attemptedTables 0, completedCalls
  # 0 and checkpointOutcome not_started. The fleet moved while it was looking.
  # Nothing was written, so this attempt may stand down and a later break may
  # enter again - it is one attempt waiting for a window it can act in, not a
  # retry loop, a sweep or a repair job (CLAUDE.md 10.12).
  #
  # The intent was written BEFORE the inspector because a disconnect is unknown.
  # This is not a disconnect: the helper answered. Retire that intent, and only
  # this one - compare the exact bytes this entry wrote, never merely the path,
  # so a file left by any other entry is a `die` and not a licence to retry. The
  # owning transaction then re-proves the absence from the filesystem itself
  # before it honours 75 (engine-release-transaction.sh), and that proof is
  # unchanged: this script does not get to tell it the intent is gone.
  timeout 5s python3 - "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" "$CHECKPOINT_INTENT" <<'PY' || die 'checkpoint reported a non-acting refusal but its own durable intent could not be retired; refusing a retry'
import os,sys
path,intent=sys.argv[1:]
with open(path,"rb") as handle: on_disk=handle.read()
if on_disk != (intent+"\n").encode(): raise SystemExit("intent on disk is not the one this entry wrote")
os.unlink(path)
fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
try: os.fsync(fd)
finally: os.close(fd)
PY
  defer_proved_not_started 'the fleet moved while the checkpoint was reading it; nothing was attempted and this entry retired its own intent'
fi
[ "$CHECKPOINT_RC" = 0 ] \
  || die 'checkpoint or inspector cleanup refused; do not retry this operation'
[ "$(timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}' "$CONTAINER")" = "$IDENTITY" ] \
  || die 'predecessor changed during checkpoint'
# This helper cannot certify or start cutover. Entry above demanded the strict
# 285000ms; the caller must now pass the original maintenance_certificate with
# the 245000ms legacy reserve (285000ms entry minus the 40000ms checkpoint
# budget, taken from candidate proof, never from the 135s rollback reserve).
