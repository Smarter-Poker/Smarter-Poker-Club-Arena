#!/usr/bin/env bash
# Finite qualification tool build. No source credentials or release operation.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == --check ]]; then
  [[ $# == 1 ]]
  bash -n "${BASH_SOURCE[0]}"
  node --check "$here/leaderboard-native-function-batch.mjs"
  test -s "$here/leaderboard-native-function-batch.Dockerfile"
  exit 0
fi
[[ $# == 1 && -d "$1" ]] || { echo 'Owned Build Scratch Parent Required.' >&2; exit 1; }
for command in docker node curl sha256sum tar; do command -v "$command" >/dev/null; done
scratch="$(mktemp -d "$1/leaderboard-native-build.XXXXXX")"
chmod 700 "$scratch"
cleanup() { local result=$?; trap - EXIT; rm -rf -- "$scratch" || result=1; [[ ! -e "$scratch" ]] || result=1; exit "$result"; }
trap cleanup EXIT
curl --fail --silent --show-error https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2 -o "$scratch/postgresql-17.11.tar.bz2"
printf '%s  %s\n' dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979 "$scratch/postgresql-17.11.tar.bz2" | sha256sum -c -
tar -xOf "$scratch/postgresql-17.11.tar.bz2" postgresql-17.11/src/bin/pg_dump/pg_dump.c > "$scratch/pg_dump.c"
node "$here/leaderboard-native-function-batch.mjs" "$scratch/pg_dump.c" "$scratch/pg_dump-batched.c"
cp "$here/leaderboard-native-function-batch.Dockerfile" "$scratch/Dockerfile"
docker build --iidfile "$scratch/image-id" "$scratch" > "$scratch/build.log" 2>&1 || { echo 'Pinned Native Qualification Client Build Failed.' >&2; tail -20 "$scratch/build.log" >&2; exit 1; }
image="$(cat "$scratch/image-id")"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
# No database URL, credentials, public ports or external network reachability.
docker run --rm --network none --user postgres --entrypoint /usr/local/bin/node \
  --mount "type=bind,src=$here,dst=/harness,readonly" \
  --mount "type=bind,src=$here/../../.github,dst=/.github,readonly" \
  -e LEADERBOARD_NATIVE_BATCH_TEST=1 -e LEADERBOARD_NATIVE_BATCH_CONTAINER=1 \
  -e LEADERBOARD_NATIVE_BATCH_SCRATCH=/tmp/native-batch-fixture \
  -e LEADERBOARD_NATIVE_BATCH_CLIENT=/opt/lb-native/bin/pg_dump \
  -e LEADERBOARD_NATIVE_BATCH_STOCK=/opt/lb-native/bin/pg_dump-stock \
  -e LEADERBOARD_NATIVE_BATCH_RUNTIME_BIN=/usr/lib/postgresql/bin \
  "$image" --test /harness/leaderboard-native-function-batch.test.mjs
[[ -n "${GITHUB_ENV:-}" ]] || { echo 'Exact Qualification Image Requires Owning Provider Job.' >&2; exit 1; }
printf 'LEADERBOARD_NATIVE_BATCH_IMAGE=%s\n' "$image" >> "$GITHUB_ENV"
echo 'Pinned Native Client Built And Actual Stock-Parity Fixture Passed.'
