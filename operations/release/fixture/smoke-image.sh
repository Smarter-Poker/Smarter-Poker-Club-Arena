#!/usr/bin/env bash
set -euo pipefail

# No production resources, credentials, image publication, or external network.
image_ref=${1:?Usage: smoke-image.sh locally-built-image-id-or-tag}
[[ "$image_ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]+$ ]] || exit 2
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires native Linux amd64 Docker' >&2; exit 2; }
image_id=$(docker image inspect --format '{{.Id}}' "$image_ref")
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
name=${FIXTURE_SMOKE_CONTAINER:-"ca-fixture-smoke-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"}
[[ "$name" =~ ^ca-fixture-smoke-[a-f0-9]{32}$ ]] || { echo 'Invalid owned smoke container name' >&2; exit 2; }
# Refuse a pre-existing name before installing cleanup; it is not ours to remove.
existing=$(docker container ls --all --format '{{.Names}}')
[[ $'\n'"$existing"$'\n' != *$'\n'"$name"$'\n'* ]] || { echo 'Owned smoke container name is already occupied' >&2; exit 2; }
cleanup() {
  local result=$?
  trap - EXIT
  if docker container inspect "$name" >/dev/null 2>&1; then
    docker rm --force "$name" >/dev/null || result=1
  fi
  local inventory
  inventory=$(docker container ls --all --format '{{.Names}}') || result=1
  if [[ $'\n'"$inventory"$'\n' == *$'\n'"$name"$'\n'* ]]; then result=1; fi
  if [[ "$result" == 0 ]]; then echo 'Native service smoke and container cleanup passed (not a product certificate).'; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

docker run --detach --name "$name" --network=none --read-only \
  --label "com.smarter-poker.fixture-smoke=$name" \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=1024 --memory=8g --cpus=2 \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --add-host realtime-dev.supabase-realtime:127.0.0.1 \
  --tmpfs /tmp:rw,nosuid,mode=1777,uid=1000,gid=1000,size=2g \
  --tmpfs /run:rw,nosuid,mode=0755,uid=1000,gid=1000,size=2g \
  --tmpfs /var/lib/postgresql:rw,nosuid,mode=0700,uid=1000,gid=1000,size=4g \
  "$image_id" node /opt/qualification/runtime/native-smoke.mjs >/dev/null

# Poll readiness only. No rerunning failed services, SQL, browser, or smoke.
deadline=$((SECONDS + 240))
while ! docker exec "$name" test -f /run/native-smoke/ready; do
  [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]] || { docker logs "$name"; exit 1; }
  (( SECONDS < deadline )) || { echo 'Native service smoke readiness timed out' >&2; exit 1; }
  sleep 1
done
docker exec --user qualification --env HOME=/tmp/qualification --env XDG_CACHE_HOME=/tmp/qualification/cache \
  "$name" node /opt/qualification/runtime/native-smoke.mjs --oracle
exit_code=$(docker wait "$name")
docker logs "$name"
[[ "$exit_code" == 0 ]]
