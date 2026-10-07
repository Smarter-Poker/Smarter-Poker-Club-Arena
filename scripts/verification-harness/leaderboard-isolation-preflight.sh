#!/usr/bin/env bash
# One explicit preflight. Never invoked by a schedule and never calls a payout.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
readonly catalog="$here/leaderboard-isolation-catalog.sql"
readonly extension_bootstrap="$here/leaderboard-isolation-extension-bootstrap.sql"
readonly image='supabase/postgres:17.6.1.063'
readonly bootstrap='leaderboard_qualification_bootstrap'
prepare_roles() {
  local role="$1" sql
  [[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$role" != "$bootstrap" ]] || return 1
  sql="$(cat)"
  [[ "$(grep -Fxc "CREATE ROLE $role;" <<< "$sql")" == 1 ]] || return 1
  awk -v exact="CREATE ROLE $role;" '$0 != exact' <<< "$sql"
}
destination_role_category() {
  local diagnostic state='unknown' category='unclassified-role-restore'
  diagnostic="$(cat)"
  if [[ "$diagnostic" =~ ERROR:[[:space:]]+([0-9A-Z]{5}): ]]; then state="${BASH_REMATCH[1]}"; fi
  case "$diagnostic" in
    *'must have admin option'*) category='grantor-admin-option' ;;
    *'already exists'*) category='duplicate-role' ;;
    *'permission denied'*|*'must be superuser'*) category='role-permission' ;;
    *'unrecognized configuration parameter'*) category='unsupported-role-configuration' ;;
    *'syntax error'*) category='role-syntax' ;;
  esac
  printf '%s:%s\n' "$state" "$category"
}
destination_error_category() {
  local diagnostic state='unknown' category='unclassified-destination'
  diagnostic="$(cat)"
  if [[ "$diagnostic" =~ ERROR:[[:space:]]+([0-9A-Z]{5}): ]]; then state="${BASH_REMATCH[1]}"; fi
  case "$diagnostic" in
    *'has no installation script nor update path for version'*|*'has no installation script for version'*) category='extension-version-unavailable' ;;
    *'extension'*'is not available'*|*'could not open extension control file'*) category='extension-control-unavailable' ;;
    *'must be loaded via shared_preload_libraries'*|*'must be loaded via shared preload'*) category='extension-preload-required' ;;
    *'required extension'*'is not installed'*) category='extension-dependency-missing' ;;
    *'schema'*'does not exist'*) category='schema-missing' ;;
    *'already exists'*) category='duplicate-destination-object' ;;
    *'permission denied'*|*'must be superuser'*|*'must be owner'*) category='destination-permission' ;;
    *'could not access file'*|*'could not load library'*) category='extension-library-unavailable' ;;
    *'unrecognized configuration parameter'*) category='unsupported-destination-configuration' ;;
    *'syntax error'*) category='destination-syntax' ;;
  esac
  printf '%s:%s\n' "$state" "$category"
}
if [[ "${1:-}" == '--classify-destination-error' ]]; then
  [[ $# == 1 ]] || exit 1
  destination_error_category
  exit 0
fi
if [[ "${1:-}" == '--prepare-roles' ]]; then
  [[ $# == 2 ]] || exit 1
  prepare_roles "$2"
  exit $?
fi
if [[ "${1:-}" == '--classify-role-error' ]]; then
  [[ $# == 1 ]] || exit 1
  destination_role_category
  exit 0
fi
source_error_category() {
  local status="$1" diagnostic
  diagnostic="$(cat)"
  if [[ "$status" == 124 ]]; then echo 'bounded-timeout'; return; fi
  if [[ "$status" == 137 ]]; then echo 'signal-termination'; return; fi
  case "$diagnostic" in
    *'canceling statement due to statement timeout'*) echo 'server-statement-timeout' ;;
    *'canceling statement due to lock timeout'*) echo 'server-lock-timeout' ;;
    *'could not translate host name'*|*'Name or service not known'*) echo 'name-resolution' ;;
    *'Network is unreachable'*|*'No route to host'*) echo 'network-route' ;;
    *'Connection refused'*) echo 'connection-refused' ;;
    *'password authentication failed'*|*'no password supplied'*) echo 'authentication' ;;
    *'SSL error'*|*'certificate verify failed'*|*'server does not support SSL'*) echo 'tls' ;;
    *'permission denied'*) echo 'catalog-permission' ;;
    *'invalid URI'*|*'invalid connection option'*|*'missing "="'*) echo 'connection-input' ;;
    *'on socket'*'No such file or directory'*) echo 'unexpected-local-socket' ;;
    *) echo 'unclassified-source-client' ;;
  esac
}
if [[ "${1:-}" == '--classify-source-error' ]]; then
  [[ $# == 2 && "$2" =~ ^[0-9]+$ ]] || exit 1
  source_error_category "$2"
  exit 0
fi
# Official tag source: supabase/postgres/17.6.1.063/Dockerfile-17 sets
# /usr/lib/postgresql/bin on PATH and delegates non-postgres commands directly.
# Override entrypoints explicitly so source reads can never bootstrap a server.

if [[ "${1:-}" == '--check' ]]; then
  bash -n "${BASH_SOURCE[0]}"
  test -s "$catalog"
  test -s "$extension_bootstrap"
  if grep -Ei '\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|CALL)\b' "$catalog" >/dev/null; then
    echo 'Catalog preflight contains a forbidden mutation.' >&2
    exit 1
  fi
  echo 'Read-only catalog and shell safeguards checked.'
  exit 0
fi
[[ $# == 0 ]] || { echo 'Unexpected preflight argument.' >&2; exit 1; }
: "${DATABASE_URL:?Configured DATABASE_URL is required; never supply it in chat.}"
: "${LEADERBOARD_ISOLATION_SCRATCH_PARENT:?An owned scratch parent is required.}"
for command in docker timeout sha256sum cmp; do
  command -v "$command" >/dev/null || { echo "Required tool unavailable: $command" >&2; exit 1; }
done
scratch="$(mktemp -d "$LEADERBOARD_ISOLATION_SCRATCH_PARENT/leaderboard-isolation.XXXXXX")"
chmod 700 "$scratch"
container="leaderboard-isolation-${GITHUB_RUN_ID:-manual}-${scratch##*.}"
network="$container-network"
source_container="$container-source"
cleanup_complete=false
cleanup() {
  local owned_container names
  [[ "$cleanup_complete" == false ]] || return 0
  docker info >"$scratch/cleanup-daemon.log" 2>&1 || { echo 'Cleanup refused: Docker state unavailable.' >&2; return 1; }
  for owned_container in "$source_container" "$container"; do
    names="$(docker container ls --all --format '{{.Names}}' 2>"$scratch/cleanup-inventory.log")" || { echo 'Cleanup refused: container inventory unavailable.' >&2; return 1; }
    if [[ $'\n'"$names"$'\n' == *$'\n'"$owned_container"$'\n'* ]]; then
      docker rm -f "$owned_container" >"$scratch/cleanup-remove.log" 2>&1 || { echo 'Cleanup failed: owned container.' >&2; return 1; }
    fi
    names="$(docker container ls --all --format '{{.Names}}' 2>"$scratch/cleanup-inventory.log")" || { echo 'Cleanup refused: final container inventory unavailable.' >&2; return 1; }
    if [[ $'\n'"$names"$'\n' == *$'\n'"$owned_container"$'\n'* ]]; then
      echo 'Cleanup failed: owned container still exists.' >&2; return 1
    fi
  done
  names="$(docker network ls --format '{{.Name}}' 2>"$scratch/cleanup-inventory.log")" || { echo 'Cleanup refused: network inventory unavailable.' >&2; return 1; }
  if [[ $'\n'"$names"$'\n' == *$'\n'"$network"$'\n'* ]]; then
    docker network rm "$network" >"$scratch/cleanup-remove.log" 2>&1 || { echo 'Cleanup failed: owned network.' >&2; return 1; }
  fi
  names="$(docker network ls --format '{{.Name}}' 2>"$scratch/cleanup-inventory.log")" || { echo 'Cleanup refused: final network inventory unavailable.' >&2; return 1; }
  if [[ $'\n'"$names"$'\n' == *$'\n'"$network"$'\n'* ]]; then
    echo 'Cleanup failed: owned network still exists.' >&2; return 1
  fi
  docker info >"$scratch/cleanup-daemon.log" 2>&1 || { echo 'Cleanup refused: final Docker state unavailable.' >&2; return 1; }
  # Only the uniquely-created directory owned by this invocation is removed.
  rm -rf -- "$scratch"
  [[ ! -e "$scratch" ]] || { echo 'Cleanup failed: owned scratch remains.' >&2; return 1; }
  cleanup_complete=true
}
on_exit() {
  status=$?
  trap - EXIT INT TERM
  if ! cleanup; then [[ "$status" != 0 ]] || status=1; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
failure() { echo "Leaderboard isolation preflight refused: $1" >&2; exit 1; }
source_failure() {
  local reason="$1" log="$2" status="$3" category state='unknown' elapsed='unknown' started
  category="$(source_error_category "$status" < "$log")"
  started="$(cat "$scratch/source-client-started" 2>/dev/null)" || started='unknown'
  if [[ "$started" =~ ^[0-9]+$ && "$started" -le "$SECONDS" ]]; then elapsed=$((SECONDS-started)); fi
  if state="$(timeout 10 docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}' "$source_container" 2>/dev/null)"; then
    [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)\|[0-9]+\|(true|false)$ ]] || state='unknown'
  else state='unknown'; fi
  failure "$reason (client-status=$status;elapsed-seconds=$elapsed;$category;owned-source-state=$state)"
}
destination_failure() {
  local stage="$1" log="$2" status="$3" category diagnostic line='unknown'
  category="$(destination_error_category < "$log")"
  diagnostic="$(cat "$log")"
  if [[ "$diagnostic" =~ (^|$'\n')psql:\<stdin\>:([0-9]+):[[:space:]]+ERROR: ]]; then line="${BASH_REMATCH[2]}"; fi
  failure "$stage (client-status=$status;$category;stdin-line=$line)"
}
docker pull "$image" >"$scratch/image.log" 2>&1 || failure 'required Supabase PostgreSQL image unavailable'
# Use the same pg_dump build on source and destination. Source credentials are
# process environment only; dumps and errors stay private and are never uploaded.
source_client() {
  local seconds="$1" client="$2"
  shift 2
  [[ "$client" == psql || "$client" == pg_dump || "$client" == pg_dumpall ]] || failure 'unsupported source client'
  printf '%s\n' "$SECONDS" >"$scratch/source-client-started"
  # PGDATABASE alone does not expand a URI. Explicit libpq connection options
  # are expanded inside the container, never placed on the host Docker argv.
  # Expansion must happen inside the source container.
  # shellcheck disable=SC2016
  timeout "$seconds" docker run --name "$source_container" --rm -i --network host -e PGDATABASE -e PGOPTIONS \
    --entrypoint /bin/sh "$image" -c \
    'client=$1; shift; case "$client" in psql|pg_dump) exec "/usr/lib/postgresql/bin/$client" --dbname="$PGDATABASE" "$@";; pg_dumpall) exec /usr/lib/postgresql/bin/pg_dumpall --database="$PGDATABASE" "$@";; *) exit 1;; esac' \
    source-client "$client" "$@"
}
source_catalog() { source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 < "$catalog"; }
export PGDATABASE="$DATABASE_URL"
export PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=5000 -c statement_timeout=120000'
bootstrap_exists="$(source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='$bootstrap');" \
  2>"$scratch/source-error.log")" || source_failure 'source bootstrap-name check unavailable' "$scratch/source-error.log" "$?"
[[ "$bootstrap_exists" == 'f' ]] || failure 'qualification bootstrap role conflicts with a source role'
source_bootstrap="$(source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  -c "SELECT rolname FROM pg_catalog.pg_roles WHERE oid=10 AND rolsuper;" \
  2>"$scratch/source-error.log")" || source_failure 'source bootstrap identity unavailable' "$scratch/source-error.log" "$?"
[[ "$source_bootstrap" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$source_bootstrap" != "$bootstrap" ]] || failure 'unsupported source bootstrap identity or attributes'
unsupported="$(source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  -c "SELECT (SELECT count(*) FROM pg_catalog.pg_subscription) + (SELECT count(*) FROM pg_catalog.pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global') OR spcacl IS NOT NULL OR spcoptions IS NOT NULL) + (SELECT count(*) FROM pg_catalog.pg_foreign_server);" \
  2>"$scratch/source-error.log")" || source_failure 'unsupported-capability catalog check unavailable' "$scratch/source-error.log" "$?"
[[ "$unsupported" == '0' ]] || failure 'subscriptions, custom tablespaces or foreign servers require a separate supported restore'
source_database="$(source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  -c 'SELECT current_database();' 2>"$scratch/source-error.log")" || source_failure 'source database identity unavailable' "$scratch/source-error.log" "$?"
[[ "$source_database" == 'postgres' ]] || failure 'source database name requires a separate supported restore'
source_catalog >"$scratch/source-before.json" 2>"$scratch/source-error.log" || source_failure 'source catalog read unavailable' "$scratch/source-error.log" "$?"
source_client 300 pg_dump \
  --schema-only --create --format=custom --no-password --no-subscriptions --lock-wait-timeout=5s \
  >"$scratch/schema.dump" 2>"$scratch/dump-error.log" || source_failure 'schema-only export unavailable' "$scratch/dump-error.log" "$?"
source_client 180 pg_dumpall --roles-only --no-role-passwords --no-password \
  >"$scratch/roles.sql" 2>"$scratch/roles-error.log" || source_failure 'password-free role export unavailable' "$scratch/roles-error.log" "$?"
source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$extension_bootstrap" >"$scratch/extensions.sql" 2>"$scratch/source-error.log" || source_failure 'extension owner metadata unavailable' "$scratch/source-error.log" "$?"
source_catalog >"$scratch/source-after.json" 2>"$scratch/source-error.log" || source_failure 'source catalog recheck unavailable' "$scratch/source-error.log" "$?"
cmp -s "$scratch/source-before.json" "$scratch/source-after.json" || failure 'source schema changed during export'
prepare_roles "$source_bootstrap" <"$scratch/roles.sql" >"$scratch/roles-restore.sql" || failure 'exact existing bootstrap role creation unavailable'
unset DATABASE_URL PGDATABASE PGOPTIONS
docker network create --internal "$network" >"$scratch/network.log" 2>&1
# Bootstrap the official PostgreSQL image without its canned application schema.
# Live roles/schema are attempted below; ownership is proven only by readback.
# Each extension is created under its source owner. No external network is allowed.
docker run -d --name "$container" --network "$network" --user postgres --entrypoint bash "$image" -c \
  '/usr/lib/postgresql/bin/initdb -U "$1" -D /tmp/leaderboard-qualification-db >/tmp/init.log 2>&1 && /usr/lib/postgresql/bin/pg_ctl -D /tmp/leaderboard-qualification-db -o "-c listen_addresses= -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements" -l /tmp/postgres.log -w start && exec sleep infinity' \
  isolated-bootstrap "$source_bootstrap" \
  >"$scratch/container.log" 2>&1 || failure 'isolated runtime cannot start'
ready=false
for _ in {1..30}; do
  if docker exec "$container" pg_isready -h /tmp -U "$bootstrap" -d postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || failure 'isolated PostgreSQL did not become ready'
docker exec "$container" psql -h /tmp -Xq -U "$source_bootstrap" -d template1 -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE $bootstrap SUPERUSER LOGIN;" >"$scratch/bootstrap-create.log" 2>&1 || failure 'isolated qualification role creation failed'
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d template1 -v ON_ERROR_STOP=1 \
  -v VERBOSITY=verbose <"$scratch/roles-restore.sql" >"$scratch/role-restore.log" 2>&1 || failure "exact roles cannot be restored ($(destination_role_category <"$scratch/role-restore.log"))"
docker exec "$container" psql -h /tmp -Xq -U "$bootstrap" -d template1 -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c 'DROP DATABASE postgres;' >"$scratch/drop-empty-database.log" 2>&1 || destination_failure 'empty local database preparation failed' "$scratch/drop-empty-database.log" "$?"
docker run --rm -i --entrypoint /usr/lib/postgresql/bin/pg_restore "$image" --list \
  <"$scratch/schema.dump" >"$scratch/archive.list" 2>"$scratch/list-error.log" || failure 'archive ordering unavailable'
awk '$4 == "DATABASE" {print}' "$scratch/archive.list" >"$scratch/database.list"
awk '$4 == "SCHEMA" {print}' "$scratch/archive.list" >"$scratch/schemas.list"
awk '$4 != "DATABASE" && $4 != "SCHEMA" && $4 != "EXTENSION" {print}' \
  "$scratch/archive.list" >"$scratch/remaining.list"
docker cp "$scratch/database.list" "$container:/tmp/database.list" >/dev/null
docker cp "$scratch/schemas.list" "$container:/tmp/schemas.list" >/dev/null
docker cp "$scratch/remaining.list" "$container:/tmp/remaining.list" >/dev/null
docker exec -i "$container" pg_restore -h /tmp -U "$bootstrap" --dbname=template1 --create \
  --schema-only --exit-on-error --use-list=/tmp/database.list \
  <"$scratch/schema.dump" >"$scratch/database-restore.log" 2>&1 || destination_failure 'database attributes cannot be restored' "$scratch/database-restore.log" "$?"
docker exec "$container" psql -h /tmp -Xq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 \
  -v VERBOSITY=verbose -c 'DROP EXTENSION plpgsql;' >"$scratch/empty-schema.log" 2>&1 || destination_failure 'empty isolated defaults cannot be prepared' "$scratch/empty-schema.log" "$?"
# PG17 pg_dump omits CREATE SCHEMA for initdb's standard public namespace.
# Retain that namespace; archive owner/ACL statements and final exact catalog
# comparison still enforce source security. Only plpgsql is recreated below.
docker exec -i "$container" pg_restore -h /tmp -U "$bootstrap" --dbname=postgres \
  --schema-only --exit-on-error --use-list=/tmp/schemas.list \
  <"$scratch/schema.dump" >"$scratch/schemas-restore.log" 2>&1 || destination_failure 'source namespaces cannot be restored' "$scratch/schemas-restore.log" "$?"
# Start pg_cron only after the database exists. Otherwise its idle launcher
# connection can prevent dropping the original empty postgres database.
docker exec "$container" pg_ctl -D /tmp/leaderboard-qualification-db -m fast -w stop \
  >"$scratch/local-stop.log" 2>&1 || failure 'isolated preload transition cannot stop'
docker exec "$container" pg_ctl -D /tmp/leaderboard-qualification-db \
  -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_cron,pg_stat_statements,pg_net -c cron.database_name=postgres -c cron.launch_active_jobs=off" \
  -l /tmp/postgres.log -w start >"$scratch/local-start.log" 2>&1 || failure 'isolated preload transition cannot start'
# The generated file contains catalog-quoted extension installation and default
# tablespace ownership statements, and is executed exclusively in isolation.
# Temporary installer privilege is transaction-scoped locally and restored to
# the original role attribute in that same transaction before any qualification.
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --file=- \
  <"$scratch/extensions.sql" >"$scratch/extension-restore.log" 2>&1 || destination_failure 'original-owner extensions or exact versions cannot be restored' "$scratch/extension-restore.log" "$?"
docker exec -i "$container" pg_restore -h /tmp -U "$bootstrap" --dbname=postgres \
  --schema-only --exit-on-error --use-list=/tmp/remaining.list \
  <"$scratch/schema.dump" >"$scratch/schema-restore.log" 2>&1 || destination_failure 'schema incompatibility during isolated restore' "$scratch/schema-restore.log" "$?"
docker exec -i "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  <"$catalog" >"$scratch/isolated.json" 2>"$scratch/local-error.log" || destination_failure 'isolated catalog readback failed' "$scratch/local-error.log" "$?"
cmp -s "$scratch/source-before.json" "$scratch/isolated.json" || failure 'isolated catalog differs from current source'
hash="$(sha256sum "$scratch/isolated.json" | cut -d' ' -f1)"
cleanup || failure 'explicit cleanup verification failed'
echo "Captured schema/security catalog coverage matched isolated restore and cleanup. Catalog SHA256: $hash"
echo 'This preflight does not qualify Supabase service/auth runtime, synthetic configuration, authorization, funding, payouts, recovery, reconciliation or worker execution.'
