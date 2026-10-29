#!/usr/bin/env bash
# Real root filesystem/users/Caddy in disposable Linux containers, never a host install.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="${RUNNER_TEMP:-${PRIVATE_RECORD_HOSTING_WORK:-}}"
[ -n "$parent" ] && [ -d "$parent" ] && [ -x "${CADDY_BIN:-}" ]
gh_binary="$(command -v gh)"
[ -x "$gh_binary" ]
command -v docker >/dev/null || { echo 'Docker unavailable; Linux bootstrap qualification is UNKNOWN' >&2; exit 1; }
work="$(mktemp -d "$parent/gateway-bootstrap-linux.XXXXXX")"
image="ca-record-bootstrap:${GITHUB_RUN_ID:-local}-$$"
trap 'docker image rm "$image" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -p "$work/source/infra/ca-origin" "$work/source/scripts/ci"
cp "$repo"/infra/ca-origin/ca-private-record-gateway* "$work/source/infra/ca-origin/"
cp "$repo"/scripts/ci/private-record-gateway-{activate,artifact,boot,bootstrap,host-identity}.mjs "$work/source/scripts/ci/"
cp "$repo/scripts/ci/fixtures/private-record-bootstrap-linux.mjs" "$work/qualification.mjs"
cat > "$work/Dockerfile" <<'DOCKER'
FROM node:22.22.0-bookworm@sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c
RUN apt-get update && apt-get install -y --no-install-recommends sudo systemd openssh-client python3 && rm -rf /var/lib/apt/lists/* && ln -s /usr/local/bin/node /usr/bin/node
COPY --chown=0:0 source/ /qualification/source/
COPY --chown=0:0 qualification.mjs /qualification/qualification.mjs
ENTRYPOINT ["/usr/bin/node", "/qualification/qualification.mjs"]
DOCKER
docker build --quiet -t "$image" "$work"
for scenario in success caddy-drift same-host rollback; do
  docker run --rm --network none --mount "type=bind,source=$CADDY_BIN,target=/usr/bin/caddy,readonly" --mount "type=bind,source=$gh_binary,target=/usr/bin/gh,readonly" "$image" "$scenario"
done
echo 'PRIVATE_RECORD_BOOTSTRAP_LINUX PASS: root IO, real users/permissions/Caddy CAS and rollback; PID1 lifecycle remains separate'
