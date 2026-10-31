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
# The native artifact is extracted from a nonrunning immutable candidate before
# the forty-second entry starts. This mode never opens the predecessor inspector.
native_artifact_read() {
  if declare -F checkpoint_entry_read >/dev/null; then
    checkpoint_entry_read "$@"
  else
    local left=$((NATIVE_PREPARATION_DEADLINE - $(date +%s) - 5))
    [ "$left" -gt 0 ] || return 124
    [ "$left" -le 5 ] || left=5
    timeout --signal=KILL "${left}s" "$@"
  fi
}
verify_native_artifacts() {
  native_artifact_read python3 - "$CONTROL_DIR/legacy-engine-checkpoint.mjs" "$1" "$2" "$3" "$4" "$5" <<'PYVERIFY'
import hashlib,json,os,re,stat,sys
control,root,sha,image,tree,run=sys.argv[1:]
def digest(p):
    st=os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022: raise SystemExit('unsafe native artifact')
    with open(p,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
with open(control,encoding='utf8') as f: pins=re.findall(r"export const LEGACY_CENSUS_NATIVE_SOURCE_SHA256 = '([0-9a-f]{64})';",f.read())
if len(pins)!=1: raise SystemExit('maintained native source pin unavailable')
binary=os.path.join(root,'legacy-census.node'); manifest=binary+'.json'
binary_hash=digest(binary); manifest_hash=digest(manifest)
with open(manifest,encoding='utf8') as f: m=json.load(f)
if not (m.get('schema')=='legacy-native-census-build/v1' and m.get('node')=='v22.23.2'
    and m.get('v8')=='12.4.254.21-node.56' and m.get('modules')=='127'
    and m.get('platform')=='linux' and m.get('arch') in ('x64','arm64')
    and m.get('pointerCompression')==0 and m.get('sourceSHA256')==pins[0]
    and m.get('binarySHA256')==binary_hash and re.fullmatch('[0-9a-f]{64}',m.get('headersSHA256',''))
    and m.get('maxMatches')==22096 and m.get('managedOutputBytes')==772608
    and m.get('qualification')=='unqualified-build-only'):
    raise SystemExit('native build provenance mismatch')
# Build provenance is deliberately not a qualification claim. Protected required
# checks and the owning release remain independent prerequisites.
print(json.dumps({'schema':'legacy-native-census-artifact/v1','path':'/app/.legacy-census-checkpoint-'+run+'/legacy-census.node',
 'manifestPath':'/app/.legacy-census-checkpoint-'+run+'/legacy-census.node.json',
 'binarySHA256':binary_hash,'manifestSHA256':manifest_hash,'sourceSHA256':pins[0],
 'candidateSHA':sha,'candidateImageId':image,'candidateSourceTree':tree},separators=(',',':')))
PYVERIFY
}
verify_native_candidate() {
  local source="$1" image="$2" tree="$3"
  native_artifact_read docker image inspect --format '{{json .}}' "$image" \
    | python3 -c '
import json,re,sys
sha,image,tree=sys.argv[1:]; d=json.load(sys.stdin); labels=(d.get("Config") or {}).get("Labels") or {}
if not (re.fullmatch("[0-9a-f]{40}",sha) and re.fullmatch("sha256:[0-9a-f]{64}",image)
 and re.fullmatch("[0-9a-f]{40}",tree) and d.get("Id")==image
 and labels.get("org.opencontainers.image.revision")==sha
 and labels.get("com.smarterpoker.engine.source-tree")==tree
 and labels.get("com.smarterpoker.engine.build-contract")=="clean-server-archive-v1"):
 raise SystemExit("immutable native candidate identity mismatch")
' "$source" "$image" "$tree"
}
prepare_native_artifacts() {
  [ "$#" = 5 ] || die 'native preparation requires run, candidate SHA/image/tree and deadline'
  local run="$1" source="$2" image="$3" tree="$4" deadline="$5" root stage cid='' descriptor
  [[ "$run" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'invalid native preparation run'
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] && [ "$deadline" -gt "$(( $(date +%s) + 20 ))" ] \
    || die 'native preparation deadline exhausted'
  local -a request
  mapfile -t request < "$REQUEST_ROOT/$run.request"
  [ "${#request[@]}" = 6 ] && [ "${request[0]}" = "$source" ] \
    && [ "${request[3]}" = "$CONTROL_DIR" ] && [ "${request[4]}" = "$(cat "$CONTROL_DIR/control-sha")" ] \
    && [[ "${request[5]}" =~ ^[1-9][0-9]*$ ]] && [ "$deadline" -le "${request[5]}" ] || die 'native preparation immutable request mismatch'
  NATIVE_PREPARATION_DEADLINE="$deadline"
  verify_native_candidate "$source" "$image" "$tree" || die 'native preparation candidate refused'
  root="$REQUEST_ROOT/$run.legacy-native-census"
  if [ -d "$root" ] && [ ! -L "$root" ]; then
    descriptor="$(verify_native_artifacts "$root" "$source" "$image" "$tree" "$run")" \
      || die 'existing native preparation refused'
    [ "$(cat "$root/descriptor.json")" = "$descriptor" ] || die 'native preparation descriptor changed'
    return
  fi
  [ ! -e "$root" ] && [ ! -L "$root" ] || die 'native preparation path already exists'
  stage="$(mktemp -d "$REQUEST_ROOT/.native-census-$run.XXXXXXXX")"
  # This subshell owns only its extraction container and unique host directory.
  # A failure never removes another run artifact or the serving predecessor.
  (
    extraction_name="legacy-native-census-$run-${stage##*.}"
    extraction_token="$(printf '%s' "$stage" | sha256sum | cut -d ' ' -f 1)"
    extraction_attempted=0
    cleanup_extraction() {
      if [ "$extraction_attempted" = 1 ]; then
        local owned_id
        owned_id="$(timeout --signal=KILL 3s docker inspect --format '{{json .}}' "$extraction_name" \
          | python3 -c '
import json,re,sys
image,token=sys.argv[1:]; d=json.load(sys.stdin); labels=(d.get("Config") or {}).get("Labels") or {}
if not (d.get("Image")==image and labels.get("sp.legacy-census.extraction")==token
 and d.get("State",{}).get("Running") is False and re.fullmatch("[0-9a-f]{64}",d.get("Id",""))):raise SystemExit(1)
print(d["Id"])
' "$image" "$extraction_token")" || return 1
        timeout --signal=KILL 2s docker rm "$owned_id" >/dev/null || return 1
      fi
      rm -rf -- "$stage"
    }
    trap 'extraction_exit=$?; cleanup_extraction || { echo "[legacy-engine-checkpoint] extraction cleanup outcome unknown; retain operation evidence" >&2; extraction_exit=1; }; exit "$extraction_exit"' EXIT
    extraction_attempted=1
    cid="$(native_artifact_read docker create --name "$extraction_name" --label "sp.legacy-census.extraction=$extraction_token" --network none "$image")" || exit 1
    [[ "$cid" =~ ^[0-9a-f]{64}$ ]] || exit 1
    native_artifact_read docker cp "$cid:/app/native/legacy-census/legacy-census.node" "$stage/legacy-census.node" || exit 1
    native_artifact_read docker cp "$cid:/app/native/legacy-census/legacy-census.node.json" "$stage/legacy-census.node.json" || exit 1
    descriptor="$(verify_native_artifacts "$stage" "$source" "$image" "$tree" "$run")" || exit 1
    printf '%s\n' "$descriptor" > "$stage/descriptor.json"
    chmod 0500 "$stage"; chmod 0400 "$stage/"*
    [ "$(date +%s)" -lt "$deadline" ] || exit 1
    timeout --signal=KILL 5s docker rm "$cid" >/dev/null || exit 1
    extraction_attempted=0
    cid=''
    mv -T -- "$stage" "$root"
    # Retain this small immutable pair and descriptor as run-owned evidence of
    # exactly which DSO was staged; recovery/terminal audits require its hashes.
    echo "[legacy-engine-checkpoint] retained immutable native artifact evidence at $root" >&2
  ) || die 'immutable native artifact preparation failed'
}
[ "$(id -u)" = 0 ] || die 'root-owned release required'
if [ "${1:-}" = --prepare-native-census ]; then
  shift
  prepare_native_artifacts "$@"
  exit 0
fi
[ "$#" = 6 ] || die 'expected owning run key, absolute entry deadline, admitted break end and immutable candidate tuple'
RUN_ID="$1"
CHECKPOINT_DEADLINE_MS="$2"
CHECKPOINT_BREAK_END_EPOCH="$3"
NATIVE_CANDIDATE_SHA="$4"
NATIVE_CANDIDATE_IMAGE="$5"
NATIVE_CANDIDATE_TREE="$6"
[[ "$CHECKPOINT_BREAK_END_EPOCH" =~ ^[1-9][0-9]{8,9}$ ]] \
  || die 'invalid admitted checkpoint break end'
[[ "$CHECKPOINT_DEADLINE_MS" =~ ^[1-9][0-9]{12}$ ]] \
  || die 'invalid absolute checkpoint deadline'
CHECKPOINT_NOW_MS="$(date +%s%3N)"
[ "$CHECKPOINT_DEADLINE_MS" -le "$((CHECKPOINT_NOW_MS + 40000))" ] \
  || die 'absolute checkpoint deadline exceeds the original forty seconds'
[ "$CHECKPOINT_DEADLINE_MS" -gt "$((CHECKPOINT_NOW_MS + 5000))" ] \
  || defer 'absolute checkpoint entry budget elapsed before intent; nothing was attempted'
[[ "$RUN_ID" =~ ^[1-9][0-9]*(-[1-9][0-9]*)?$ ]] || die 'invalid run key'
# Read-only preflight cannot consume the five seconds reserved for native
# cleanup. A killed client leaves the durable intent untouched and unknown.
checkpoint_entry_read() {
  local remaining_ms=$((CHECKPOINT_DEADLINE_MS - $(date +%s%3N) - 5000)) budget_duration
  [ "$remaining_ms" -gt 1000 ] || return 124
  remaining_ms=$((remaining_ms - 1000))
  if [ "${1:-}" = timeout ]; then
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in --signal=TERM|--kill-after=1s|--kill-after=5s) shift ;; *) break ;; esac
    done
    [[ "${1:-}" =~ ^([1-9][0-9]*)s$ ]] || return 124
    local requested_ms=$((BASH_REMATCH[1] * 1000))
    [ "$requested_ms" -ge "$remaining_ms" ] || remaining_ms="$requested_ms"
    shift
  fi
  printf -v budget_duration '%d.%03ds' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))"
  timeout --signal=TERM --kill-after=1s "$budget_duration" "$@"
}
checkpoint_final_read() {
  local remaining_ms=$((CHECKPOINT_DEADLINE_MS - $(date +%s%3N))) budget_duration
  [ "$remaining_ms" -gt 0 ] || return 124
  # No extra grace outside the absolute entry budget. This kills only the
  # bounded client, never the serving engine; unknown ownership stays retained.
  if [ "${1:-}" = timeout ]; then
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in --signal=TERM|--kill-after=1s|--kill-after=5s) shift ;; *) break ;; esac
    done
    [[ "${1:-}" =~ ^([1-9][0-9]*)s$ ]] || return 124
    local requested_ms=$((BASH_REMATCH[1] * 1000))
    [ "$requested_ms" -ge "$remaining_ms" ] || remaining_ms="$requested_ms"
    shift
  fi
  printf -v budget_duration '%d.%03ds' "$((remaining_ms / 1000))" "$((remaining_ms % 1000))"
  timeout --signal=KILL "$budget_duration" "$@"
}
# /var/lock is a symlink to /run/lock on the engine host. Compare the held
# descriptor's file identity, not a resolved path against its configured alias.
[ "/proc/$$/fd/9" -ef "${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}" ] \
  || die 'owning engine lock descriptor missing'
flock -n 9 || die 'owning engine lock unavailable'
mapfile -t REQUEST < "$REQUEST_ROOT/$RUN_ID.request"
[ "${#REQUEST[@]}" = 6 ] && [ "${REQUEST[0]}" = "$NATIVE_CANDIDATE_SHA" ] \
  && [ "${REQUEST[3]}" = "$CONTROL_DIR" ] \
  && [ "${REQUEST[4]}" = "$(cat "$CONTROL_DIR/control-sha")" ] \
  || die 'immutable operation generation mismatch'
[ "$(date +%s)" -lt "${REQUEST[5]}" ] || die 'owning operation expired'
verify_native_candidate "$NATIVE_CANDIDATE_SHA" "$NATIVE_CANDIDATE_IMAGE" "$NATIVE_CANDIDATE_TREE" \
  || die 'native candidate identity refused before checkpoint'
NATIVE_ARTIFACT_ROOT="$REQUEST_ROOT/$RUN_ID.legacy-native-census"
NATIVE_DESCRIPTOR="$(verify_native_artifacts "$NATIVE_ARTIFACT_ROOT" "$NATIVE_CANDIDATE_SHA" "$NATIVE_CANDIDATE_IMAGE" "$NATIVE_CANDIDATE_TREE" "$RUN_ID")" \
  || die 'native candidate artifact verification failed before checkpoint'
[ "$(cat "$NATIVE_ARTIFACT_ROOT/descriptor.json")" = "$NATIVE_DESCRIPTOR" ] \
  || die 'native candidate descriptor mismatch'
LEGACY_SHA="$(checkpoint_entry_read timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-sha)" \
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
  eed06fe51dea622069c661a6213d5b031ff3a9e3)
    LEGACY_IMAGE=sha256:2eb1c5a7279032240c5fff8a6b3ecf5dc6af735cc1227a51430d50dcae1b065b ;;
  *) die 'sealed predecessor has no qualified checkpoint profile' ;;
esac
[ "$(checkpoint_entry_read timeout 3s "$CONTROL_DIR/engine-release-seal.py" get desired-image-id)" = "$LEGACY_IMAGE" ] \
  || die 'sealed predecessor is not the qualified legacy image'
IDENTITY="$(checkpoint_entry_read timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}' "$CONTAINER")"
read -r CONTAINER_ID IMAGE RUNNING STARTED_AT HOST_PID <<< "$IDENTITY"
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] && [ "$IMAGE" = "$LEGACY_IMAGE" ] \
  && [ "$RUNNING" = true ] || die 'serving predecessor identity mismatch'
if [ "$LEGACY_SHA" = 8825af51817f379c4261658ca29ecc9d8d81932d ]; then
  [ "$CONTAINER_ID" = c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66 ] \
    && [ "$STARTED_AT" = 2026-09-18T21:55:50.88305198Z ] && [ "$HOST_PID" = 1231816 ] \
    || die 'original mixed-custody process changed'
fi
NODE_BOOT_STARTED_MS="$(date +%s%3N)"
# Preserve the existing container-option refusal before starting a neutral
# observer. Never execute application preloads or open the observer inspector.
checkpoint_entry_read timeout 3s docker exec "$CONTAINER_ID" sh -c '
case "${NODE_OPTIONS-}" in *--inspect*|*--debug*) exit 1 ;; esac
exec env -u NODE_OPTIONS -u NODE_PATH node --no-inspect "$@"
' checkpoint-runtime -e '
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
# The measured split does not strand unused entry time: the caller's absolute
# deadline passes unchanged to native work and its reserved cleanup slice.
echo "[legacy-engine-checkpoint] predecessor runtime check took ${NODE_BOOT_MS}ms; the guard boot it proxies is inside the 40000ms legacy checkpoint budget" >&2

# Installed SQL is a prerequisite, not a trial mutation. Refuse before the
# durable one-shot intent or inspector; the existing transaction owns failure.
if [ "$LEGACY_SHA" = 8825af51817f379c4261658ca29ecc9d8d81932d ]; then
  checkpoint_entry_read timeout 8s python3 "$CONTROL_DIR/engine-release-database-proof.py" \
    --env-file "${ENGINE_ENV_FILE:-/opt/club-arena/server/.env}" --sha "$LEGACY_SHA" \
    --mixed-custody-contract \
    || die 'installed mixed-custody contract unavailable or incompatible; checkpoint not started'
fi

INSTANCE="$(checkpoint_entry_read curl -sS --max-time 2 http://127.0.0.1:8080/health | checkpoint_entry_read python3 -c '
import json,math,re,sys,time
d=json.load(sys.stdin); m=d.get("maintenance",{}); instance=d.get("instanceId",""); release=sys.argv[1]
# The initial admission already held 285000ms. This same-break recheck pays
# only the unspent portion of that exact absolute40 entry: 245000 plus the
# remaining entry budget. It cannot grant another40 or spend rollback time.
# (No apostrophes here: this comment is inside a single-quoted Python program.)
remaining_entry=int(sys.argv[2])-math.floor(time.time()*1000)
if not 5000<remaining_entry<=40000: raise SystemExit(1)
reserve=245000+remaining_entry
ok=(d.get("running") is True and d.get("version")==release[:8] and re.fullmatch(r"1-[0-9a-f]{8}",instance)
    and (release=="2f4e33560bcd23bfb5cc731f31816b2c2e2847e5" or d.get("releaseSha")==release)
    and m.get("active") is True and m.get("phase")=="counting_down"
    and m.get("durableConfirmed") is True and m.get("remainingMs",0)>=reserve
    and isinstance(m.get("breakEndsAt"),(int,float)) and not isinstance(m.get("breakEndsAt"),bool)
    and math.isfinite(m["breakEndsAt"]) and math.floor(m["breakEndsAt"]/1000)==int(sys.argv[3])
    and m["breakEndsAt"]-time.time()*1000>=reserve)
if not ok: raise SystemExit(1)
print(instance)
' "$LEGACY_SHA" "$CHECKPOINT_DEADLINE_MS" "$CHECKPOINT_BREAK_END_EPOCH")" || defer 'the break window closed before the checkpoint could start; nothing was attempted'

# Persist intent before opening debugger access. A disconnect is unknown, not
# permission to invoke again. Existing release recovery retains this run key.
[ "$CHECKPOINT_DEADLINE_MS" -gt "$(( $(date +%s%3N) + 5000 ))" ] \
  || defer 'absolute checkpoint entry budget elapsed before intent; nothing was attempted'
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
CHECKPOINT_INTENT="$(checkpoint_entry_read python3 - "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" "$INSTANCE" "$CONTAINER_ID" "$STARTED_AT" "$HOST_PID" "$LEGACY_SHA" "$RUN_ID" "${REQUEST[4]}" "$NATIVE_DESCRIPTOR" <<'PY'
import json,os,sys,time,uuid
path,instance,container,started,pid,source,run,control,native=sys.argv[1:]
intent={"instance":instance,"container":container,"startedAt":started,"hostPid":int(pid),
        "source":source,"runId":run,"controlSha":control,"at":time.time(),"retryAllowed":False,"nativeCensus":json.loads(native)}
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
    serialized=json.dumps(intent,separators=(",",":"))
    os.write(fd,(serialized+"\n").encode())
    os.fsync(fd)
finally: os.close(fd)
fd=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
try: os.fsync(fd)
finally: os.close(fd)
print(serialized)
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

# Staging is inside the original one-shot intent and absolute forty seconds.
# No code is loaded here. The MJS guard verifies this descriptor again before
# its one synchronous native call. A DSO mapping, once loaded, can remain in the
# predecessor until exit; removing these files never claims to unload its code.
NATIVE_CAPTURE_DIR="/app/.legacy-census-checkpoint-$RUN_ID"
NATIVE_CAPTURE_ATTEMPTED=0
NATIVE_CAPTURE_TOKEN="$(printf '%s' "$CHECKPOINT_INTENT" | sha256sum | cut -d ' ' -f 1)"
cleanup_native_capture() {
  [ "$NATIVE_CAPTURE_ATTEMPTED" = 1 ] || return 0
  checkpoint_final_read docker exec "$CONTAINER_ID" env -u NODE_OPTIONS -u NODE_PATH node --no-inspect -e '
const fs=require("node:fs"),p=process.argv[1],token=process.argv[2];
try {fs.lstatSync(p)}catch(e){if(e.code==="ENOENT")process.exit(0);throw e}
const dir=fs.lstatSync(p),marker=p+"/.ownership",m=fs.lstatSync(marker);
if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==0||!m.isFile()||m.isSymbolicLink()||m.uid!==0||(m.mode&0o022)||fs.readFileSync(marker,"utf8")!==token+"\n")process.exit(1);
for(const name of ["legacy-census.node","legacy-census.node.json"]){try{fs.unlinkSync(p+"/"+name)}catch(e){if(e.code!=="ENOENT")throw e}}
fs.unlinkSync(marker);fs.rmdirSync(p);
' "$NATIVE_CAPTURE_DIR" "$NATIVE_CAPTURE_TOKEN" || return 1
  NATIVE_CAPTURE_ATTEMPTED=0
}
trap 'native_exit=$?; cleanup_native_capture || native_exit=1; exit "$native_exit"' EXIT
# Mark attempted before sending: an acknowledgement loss cannot skip ownership
# cleanup. A missing/mismatched marker refuses cleanup and retains the intent.
NATIVE_CAPTURE_ATTEMPTED=1
checkpoint_entry_read docker exec "$CONTAINER_ID" sh -c '
  [ "$#" = 2 ] && [ ! -e "$1" ] && [ ! -L "$1" ] && [ -d /app ] || exit 1
  mkdir -m 0700 -- "$1" && (umask 077; set -C; printf "%s\n" "$2" > "$1/.ownership")
' native-capture-create "$NATIVE_CAPTURE_DIR" "$NATIVE_CAPTURE_TOKEN" || die 'native capture directory creation outcome unknown; intent retained'
checkpoint_entry_read docker cp "$NATIVE_ARTIFACT_ROOT/legacy-census.node" "$CONTAINER_ID:$NATIVE_CAPTURE_DIR/legacy-census.node" \
  || die 'native capture binary staging failed; intent retained'
checkpoint_entry_read docker cp "$NATIVE_ARTIFACT_ROOT/legacy-census.node.json" "$CONTAINER_ID:$NATIVE_CAPTURE_DIR/legacy-census.node.json" \
  || die 'native capture manifest staging failed; intent retained'
checkpoint_entry_read docker exec "$CONTAINER_ID" sh -c '
  chmod 0400 -- "$1/.ownership" "$1/legacy-census.node" "$1/legacy-census.node.json" && chmod 0500 -- "$1"
' native-capture-permissions "$NATIVE_CAPTURE_DIR" || die 'native capture permissions refused'
checkpoint_entry_read docker exec "$CONTAINER_ID" env -u NODE_OPTIONS -u NODE_PATH node --no-inspect -e '
const fs=require("node:fs"),crypto=require("node:crypto"),d=JSON.parse(process.argv[1]);
const hash=p=>{const s=fs.lstatSync(p);if(!s.isFile()||s.uid!==0||(s.mode&0o022))throw Error("unsafe native artifact");return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")};
if(hash(d.path)!==d.binarySHA256||hash(d.manifestPath)!==d.manifestSHA256)process.exit(1);
const m=JSON.parse(fs.readFileSync(d.manifestPath,"utf8"));
if(process.version!==m.node||process.versions.v8!==m.v8||process.versions.modules!==m.modules||process.platform!==m.platform||process.arch!==m.arch||process.config.variables.v8_enable_pointer_compression!==m.pointerCompression||m.sourceSHA256!==d.sourceSHA256||process.env.GIT_COMMIT_SHA!==process.argv[2])process.exit(1);
' "$NATIVE_DESCRIPTOR" "$LEGACY_SHA" || die 'staged native identity refused before load'

set +e
{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs"; cat "$CONTROL_DIR/retained-original-checkpoint-guard.mjs"; cat "$CONTROL_DIR/legacy-engine-checkpoint.mjs"; } \
  | checkpoint_final_read docker exec -i "$CONTAINER_ID" env -u NODE_OPTIONS -u NODE_PATH node --no-inspect --input-type=module - "$INSTANCE" "$LEGACY_SHA" "$CHECKPOINT_INTENT" "$CHECKPOINT_DEADLINE_MS"
CHECKPOINT_RC=$?
set -e
if ! cleanup_native_capture; then
  trap - EXIT
  die 'native capture file cleanup refused; DSO mapping may remain until predecessor exit'
fi
trap - EXIT
echo '[legacy-engine-checkpoint] native capture files removed; loaded DSO code may remain mapped until predecessor exit; handle cleanup is proved separately by the native guard' >&2
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
  checkpoint_final_read timeout 5s python3 - "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" "$CHECKPOINT_INTENT" <<'PY' || die 'checkpoint reported a non-acting refusal but its own durable intent could not be retired; refusing a retry'
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
[ "$(checkpoint_final_read timeout 3s docker inspect --format '{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.State.Pid}}' "$CONTAINER")" = "$IDENTITY" ] \
  || die 'predecessor changed during checkpoint'
# This helper cannot certify or start cutover. Entry above demanded the strict
# 285000ms; the caller must now pass the original maintenance_certificate with
# the 245000ms legacy reserve (285000ms entry minus the 40000ms checkpoint
# budget, taken from candidate proof, never from the 135s rollback reserve).
