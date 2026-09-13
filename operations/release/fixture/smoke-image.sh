#!/usr/bin/env bash
set -euo pipefail

# Only literal step names and numeric exits leave this command boundary.
# Never publish BASH_COMMAND, tracing, Docker errors or private service logs.
smoke_step=arguments
report_exit() {
  local result=$1
  if (( result != 0 )); then
    printf '{"status":"failed","stage":"smoke-shell-%s","error":"Error","exit_code":%d}\n' "$smoke_step" "$result" >&2
  fi
}
trap 'report_exit "$?"' EXIT

# No production resources, credentials, image publication, or external network.
image_ref=${1:?Usage: smoke-image.sh locally-built-image-id-or-tag}
[[ "$image_ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]+$ ]] || exit 2
smoke_step=platform
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires native Linux amd64 Docker' >&2; exit 2; }
smoke_step=source
fixture_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(git -C "$fixture_dir" rev-parse --show-toplevel)
revision=$(git -C "$repo_dir" rev-parse HEAD)
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
smoke_step=image-identity
image_id=$(docker image inspect --format '{{.Id}}' "$image_ref")
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
for label in control-revision source-revision; do
  observed=$(docker image inspect --format "{{index .Config.Labels \"com.smarter-poker.$label\"}}" "$image_id")
  [[ "$observed" == "$revision" ]] || { echo 'Smoke image and reviewed controls differ' >&2; exit 2; }
done
smoke_step=helpers
helpers=(operations/release/native/component-observation-protocol.mjs operations/release/native/component-observation-client.mjs operations/release/native/component-semantic-observations.mjs)
git -C "$repo_dir" diff --quiet HEAD -- "${helpers[@]}" || { echo 'Commit reviewed observation helpers before smoke' >&2; exit 2; }
smoke_step=owned-names
name=${FIXTURE_SMOKE_CONTAINER:-"ca-fixture-smoke-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"}
[[ "$name" =~ ^ca-fixture-smoke-[a-f0-9]{32}$ ]] || { echo 'Invalid owned smoke container name' >&2; exit 2; }
peer="$name-peer"
preimage="$name-preimage"
network="$name-network"
preimage_output=${FIXTURE_SERVICE_PREIMAGE_PATH:?An explicit owned preimage output path is required}
[[ "$preimage_output" = /* && ! -e "$preimage_output" && ! -L "$preimage_output" ]] || exit 2
# Refuse a pre-existing name before installing cleanup; it is not ours to remove.
existing=$(docker container ls --all --format '{{.Names}}')
for owned in "$name" "$peer" "$preimage"; do
  [[ $'\n'"$existing"$'\n' != *$'\n'"$owned"$'\n'* ]] || { echo 'Owned smoke container name is already occupied' >&2; exit 2; }
done
existing_networks=$(docker network ls --format '{{.Name}}')
[[ $'\n'"$existing_networks"$'\n' != *$'\n'"$network"$'\n'* ]] || { echo 'Owned smoke network name is already occupied' >&2; exit 2; }
smoke_controls=''
cleanup() {
  local result=$?
  local original_result=$result
  trap - EXIT
  local owned
  for owned in "$preimage" "$peer" "$name"; do
    if docker container inspect "$owned" >/dev/null 2>&1; then
      docker rm --force "$owned" >/dev/null || result=1
    fi
  done
  local inventory
  inventory=$(docker container ls --all --format '{{.Names}}') || result=1
  for owned in "$preimage" "$peer" "$name"; do
    if [[ $'\n'"$inventory"$'\n' == *$'\n'"$owned"$'\n'* ]]; then result=1; fi
  done
  if docker network inspect "$network" >/dev/null 2>&1; then
    docker network rm "$network" >/dev/null || result=1
  fi
  inventory=$(docker network ls --format '{{.Name}}') || result=1
  if [[ $'\n'"$inventory"$'\n' == *$'\n'"$network"$'\n'* ]]; then result=1; fi
  if [[ -n "$smoke_controls" ]]; then rm -rf -- "$smoke_controls" || result=1; fi
  if (( original_result == 0 && result != 0 )); then smoke_step=cleanup; fi
  report_exit "$result"
  if [[ "$result" == 0 ]]; then echo 'Native service smoke and container/network cleanup passed (not a product certificate).'; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Only these three exact committed, credential-free helpers enter the container.
# The full checkout, .git, runner environment and Docker socket are not mounted.
smoke_step=helper-staging
smoke_controls=$(mktemp -d /tmp/ca-fixture-smoke-controls.XXXXXXXX)
mkdir -p "$smoke_controls/operations/release/native"
chmod 0755 "$smoke_controls" "$smoke_controls/operations" "$smoke_controls/operations/release" "$smoke_controls/operations/release/native"
for helper in "${helpers[@]}"; do
  git -C "$repo_dir" show "$revision:$helper" > "$smoke_controls/$helper"
  chmod 0444 "$smoke_controls/$helper"
done
printf '{"version":1,"control_sha":"%s"}\n' "$revision" > "$smoke_controls/smoke-control.json"
chmod 0444 "$smoke_controls/smoke-control.json"

smoke_step=network-create
docker network create --internal --label "com.smarter-poker.fixture-smoke=$name" "$network" >/dev/null
[[ $(docker network inspect --format '{{.Internal}}' "$network") == true ]] || exit 1
smoke_step=services-start
docker run --detach --name "$name" --network "$network" --network-alias fixture --read-only --user 1000:1000 \
  --label "com.smarter-poker.fixture-smoke=$name" \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024 --memory=8g --cpus=2 \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --add-host realtime-dev.supabase-realtime:127.0.0.1 \
  --tmpfs /tmp:rw,nosuid,mode=1777,uid=1000,gid=1000,size=2g \
  --tmpfs /run:rw,nosuid,mode=0755,uid=1000,gid=1000,size=2g \
  --tmpfs /run/fixture-observer:rw,nosuid,noexec,size=1m,uid=1000,gid=1001,mode=2750 \
  --tmpfs /var/lib/postgresql:rw,nosuid,mode=0700,uid=1000,gid=1000,size=4g \
  --mount "type=bind,source=$smoke_controls,target=/opt/qualification/controls,readonly" \
  "$image_id" node /opt/qualification/runtime/native-smoke.mjs >/dev/null

# Poll readiness only. No rerunning failed services, SQL, browser, or smoke.
smoke_step=services-ready
deadline=$((SECONDS + 240))
while ! docker exec "$name" test -f /run/native-smoke/ready; do
  [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]] || { docker logs "$name"; exit 1; }
  (( SECONDS < deadline )) || { echo 'Native service smoke readiness timed out' >&2; exit 1; }
  sleep 1
done
# A distinct mount/PID/network namespace proves peer isolation; docker exec in
# the service container would merely prove its intended local access.
smoke_step=peer
docker run --name "$peer" --network "$network" --read-only --user 1000:1000 \
  --label "com.smarter-poker.fixture-smoke=$name" \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --memory=1g --cpus=1 \
  --tmpfs /tmp:rw,nosuid,mode=1777,uid=1000,gid=1000,size=64m \
  "$image_id" node /opt/qualification/runtime/native-smoke.mjs --peer
smoke_step=oracle
docker exec --user 1001:1001 --env HOME=/tmp/qualification --env XDG_CACHE_HOME=/tmp/qualification/cache \
  "$name" node /opt/qualification/runtime/native-smoke.mjs --oracle
smoke_step=services-shutdown
exit_code=$(docker wait "$name")
docker logs "$name"
[[ "$exit_code" == 0 ]]

# A fresh invocation of the actual fixture bootstrap supplies its exact
# pre-application catalog. The smoke's synthetic schema is not this preimage.
# No application archive, browser, user signup, engine or external network.
smoke_step=preimage-start
docker run --detach --name "$preimage" --network "$network" --read-only --user 1000:1000 \
  --label "com.smarter-poker.fixture-smoke=$name" \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024 --memory=8g --cpus=2 \
  --add-host realtime-dev.supabase-realtime:127.0.0.1 \
  --tmpfs /tmp:rw,nosuid,mode=1777,uid=1000,gid=1000,size=2g \
  --tmpfs /run:rw,nosuid,mode=0755,uid=1000,gid=1000,size=2g \
  --tmpfs /var/lib/postgresql:rw,nosuid,mode=0700,uid=1000,gid=1000,size=4g \
  "$image_id" fixture-server preimage >/dev/null
smoke_step=preimage-ready
deadline=$((SECONDS + 180))
while ! docker exec "$preimage" test -f /run/club-arena-qualification/service-preimage.ready; do
  [[ $(docker inspect --format '{{.State.Running}}' "$preimage") == true ]] || { docker logs "$preimage"; exit 1; }
  (( SECONDS < deadline )) || { echo 'Native service preimage capture timed out' >&2; exit 1; }
  sleep 1
done
smoke_step=preimage-copy
# Docker's archive copy API does not reliably expose live tmpfs mounts. Read
# this single fixed file inside its mount namespace; never extract an archive.
# Both sides bound the bytes. Pipefail prevents ACK after a partial/failed read.
docker exec "$preimage" node --input-type=module -e '
import { readFixtureServicePreimage } from "/opt/qualification/runtime/service-preimage.mjs";
process.stdout.write(await readFixtureServicePreimage());
' | python3 -c '
import os, sys
raw = sys.stdin.buffer.read(1024 * 1024 + 1)
if not 0 < len(raw) <= 1024 * 1024:
    sys.exit(1)
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "wb") as output:
    output.write(raw)
    output.flush()
    os.fsync(output.fileno())
' "$preimage_output"
smoke_step=preimage-ack
docker exec "$preimage" touch /run/club-arena-qualification/service-preimage.copied
smoke_step=preimage-shutdown
while [[ $(docker inspect --format '{{.State.Running}}' "$preimage") == true ]]; do
  (( SECONDS < deadline )) || { echo 'Native service preimage capture timed out' >&2; exit 1; }
  sleep 1
done
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$preimage")
docker logs "$preimage"
[[ "$exit_code" == 0 ]]
