#!/usr/bin/env bash
# Host Python; all PostgreSQL executables run inside the unchanged pinned image.
root="$(cd "$(dirname "$0")/../.." && pwd)"
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then echo "Pinned image qualification requires Linux CI or local Linux." >&2; exit 1; fi
image=supabase/postgres@sha256:432d12926b09e10eb3317b0e2e9672c9ce8ea6bccb359857a31ff9f90683161d
scratch="$RUNNER_TEMP/schema-rebuild"
tools="$RUNNER_TEMP/schema-pg-tools"
mkdir -m 700 "$scratch" "$tools"
results="${1:?Result directory required}"
mkdir -p "$results"
container=$(docker run -d --rm --network none --platform linux/amd64 \
  --user "$(id -u):$(id -g)" --entrypoint /bin/sleep \
  -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  -v "$scratch:$scratch:rw" "$image" infinity)
trap 'docker stop "$container" >/dev/null' EXIT
export SCHEMA_REBUILD_CONTAINER="$container"
for command in postgres initdb pg_ctl psql pg_dump; do
  cat > "$tools/$command" <<'WRAPPER'
#!/bin/sh
exec docker exec -i "$SCHEMA_REBUILD_CONTAINER" "/usr/lib/postgresql/bin/$(basename "$0")" "$@"
WRAPPER
  chmod 700 "$tools/$command"
done
"$tools/postgres" --version
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-catalog.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-fidelity.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-forward-schema.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-opening-schema.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-journal-index-schema.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-pick-schema.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-invalid-index.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" SCHEMA_PROVIDER_TEST=1 python3 "$root/scripts/schema-rebuild/test-role-bootstrap.py"
PG_BIN="$tools" SCHEMA_TEST_SCRATCH="$scratch" python3 "$root/scripts/schema-rebuild/test-lock-budget.py"
python3 "$root/scripts/schema-rebuild/verify.py" --scratch "$scratch" \
  --result "$results/result.json" --pg-bin "$tools"
