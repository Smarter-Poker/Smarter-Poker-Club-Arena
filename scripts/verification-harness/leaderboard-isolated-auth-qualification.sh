#!/usr/bin/env bash
# One explicit preflight. Never invoked by a schedule and never calls a payout.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
readonly catalog="$here/leaderboard-isolation-catalog.sql"
readonly extension_bootstrap="$here/leaderboard-isolation-extension-bootstrap.sql"
readonly event_owner_bootstrap="$here/leaderboard-isolation-event-owner-bootstrap.sql"
readonly extension_trigger_bootstrap="$here/leaderboard-isolation-extension-trigger-bootstrap.sql"
readonly acl_bootstrap="$here/leaderboard-isolation-acl-bootstrap.sql"
readonly definition_bootstrap="$here/leaderboard-isolation-definition-bootstrap.sql"
readonly restore_script_helper="$here/leaderboard-isolation-restore-script.mjs"
readonly startup_helper="$here/leaderboard-isolation-startup-profile.mjs"
readonly catalog_diagnostic="$here/leaderboard-isolation-catalog-diagnostic.mjs"
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
    *'out of shared memory'*'max_locks_per_transaction'*) category='shared-memory-lock-capacity' ;;
    *'out of shared memory'*) category='shared-memory-unclassified' ;;
    *'out of memory'*) category='server-memory-unavailable' ;;
    *'has no installation script nor update path for version'*|*'has no installation script for version'*) category='extension-version-unavailable' ;;
    *'extension'*'is not available'*|*'could not open extension control file'*) category='extension-control-unavailable' ;;
    *'must be loaded via shared_preload_libraries'*|*'must be loaded via shared preload'*) category='extension-preload-required' ;;
    *'required extension'*'is not installed'*) category='extension-dependency-missing' ;;
    *'schema'*'does not exist'*) category='schema-missing' ;;
    *'already exists'*) category='duplicate-destination-object' ;;
    *'must be owner'*) category='destination-owner-required' ;;
    *'must be superuser'*) category='destination-superuser-required' ;;
    *'permission denied for function'*) category='destination-function-permission' ;;
    *'permission denied for schema'*) category='destination-schema-permission' ;;
    *'permission denied for table'*|*'permission denied for relation'*) category='destination-relation-permission' ;;
    *'permission denied'*) category='destination-permission' ;;
    *'could not access file'*|*'could not load library'*) category='extension-library-unavailable' ;;
    *'unrecognized configuration parameter'*) category='unsupported-destination-configuration' ;;
    *'syntax error'*) category='destination-syntax' ;;
  esac
  if [[ "$category" == unclassified-destination && "$state" == 53200 ]]; then category='server-memory-unclassified'; fi
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
source_progress() {
  local entry client='' started=0 completed=0 status='unknown' phase='unknown' valid=true
  while IFS= read -r entry; do
    if [[ "$entry" =~ ^LB_SOURCE_CLIENT_START:(psql|pg_dump|pg_dumpall)$ ]]; then
      started=$((started+1)); client="${BASH_REMATCH[1]}"
    elif [[ "$entry" =~ ^LB_SOURCE_CLIENT_COMPLETE:(psql|pg_dump|pg_dumpall):([0-9]+)$ ]]; then
      completed=$((completed+1))
      [[ "$started" == 1 && "${BASH_REMATCH[1]}" == "$client" ]] || valid=false
      status="${BASH_REMATCH[2]}"
      if [[ ! "$status" =~ ^(0|[1-9][0-9]{0,2})$ ]] || [[ "$status" -gt 255 ]]; then valid=false; fi
    elif [[ "$entry" == LB_SOURCE_CLIENT_* ]]; then valid=false
    fi
    # Exact PG17 common.c / pg_dump.c messages, never object-bearing output.
    if [[ "$valid" == true && "$started" == 1 && "$completed" == 0 && "$client" == pg_dump ]]; then
    case "$entry" in
      'pg_dump: reading extensions') phase='extensions' ;;
      'pg_dump: identifying extension members') phase='extension-members' ;;
      'pg_dump: reading schemas') phase='schemas' ;;
      'pg_dump: reading user-defined tables') phase='tables' ;;
      'pg_dump: reading user-defined functions') phase='functions' ;;
      'pg_dump: reading user-defined types') phase='types' ;;
      'pg_dump: reading table inheritance information') phase='inheritance' ;;
      'pg_dump: reading event triggers') phase='event-triggers' ;;
      'pg_dump: reading column info for interesting tables') phase='columns' ;;
      'pg_dump: finding table default expressions') phase='column-defaults' ;;
      'pg_dump: finding table check constraints') phase='table-checks' ;;
      'pg_dump: reading indexes') phase='indexes' ;;
      'pg_dump: reading constraints') phase='constraints' ;;
      'pg_dump: reading triggers') phase='triggers' ;;
      'pg_dump: reading policies') phase='policies' ;;
      'pg_dump: reading dependency data') phase='dependencies' ;;
    esac
    fi
  done
  if [[ "$valid" != true || "$started" != 1 || "$completed" -gt 1 ]]; then status='unknown'; phase='unknown'; fi
  [[ "$completed" == 1 ]] || status='unknown'
  printf 'inner-status=%s;dump-stage=%s\n' "$status" "$phase"
}
if [[ "${1:-}" == '--classify-source-progress' ]]; then
  [[ $# == 1 ]] || exit 1
  source_progress
  exit 0
fi
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
  test -s "$event_owner_bootstrap"
  test -s "$extension_trigger_bootstrap"
  test -s "$acl_bootstrap"
  test -s "$definition_bootstrap"
  test -s "$restore_script_helper"
  test -s "$startup_helper"
  test -s "$catalog_diagnostic"
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
for command in docker timeout sha256sum cmp node; do
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
  local reason="$1" log="$2" status="$3" category state='unknown' elapsed='unknown' started progress
  category="$(source_error_category "$status" < "$log")"
  progress="$(source_progress < "$log")"
  started="$(cat "$scratch/source-client-started" 2>/dev/null)" || started='unknown'
  if [[ "$started" =~ ^[0-9]+$ && "$started" -le "$SECONDS" ]]; then elapsed=$((SECONDS-started)); fi
  if state="$(timeout 10 docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}' "$source_container" 2>/dev/null)"; then
    [[ "$state" =~ ^(created|running|paused|restarting|removing|exited|dead)\|[0-9]+\|(true|false)$ ]] || state='unknown'
  else state='unknown'; fi
  failure "$reason (client-status=$status;elapsed-seconds=$elapsed;$category;owned-source-state=$state;$progress)"
}
destination_failure() {
  local stage="$1" log="$2" status="$3" category diagnostic line='unknown' toc='unknown' kind='unknown' entry candidate
  category="$(destination_error_category < "$log")"
  diagnostic="$(cat "$log")"
  if [[ "$diagnostic" =~ (^|$'\n')psql:(\<stdin\>|/tmp/remaining\.sql|/tmp/event-owners-elevate\.sql|/tmp/event-owners-restore\.sql):([0-9]+):[[:space:]]+ERROR: ]]; then line="${BASH_REMATCH[3]}"; fi
  while IFS= read -r entry; do
    if [[ "$entry" =~ ^pg_restore:\ from\ TOC\ entry\ ([0-9]+)\;\ [0-9]+\ [0-9]+\ (.*)$ ]]; then
      toc="${BASH_REMATCH[1]}"
      entry="${BASH_REMATCH[2]}"
      for candidate in 'DEFAULT ACL' 'EVENT TRIGGER' 'MATERIALIZED VIEW' 'FOREIGN TABLE' 'DATABASE PROPERTIES' FUNCTION PROCEDURE TABLE SCHEMA DATABASE EXTENSION VIEW SEQUENCE TYPE DOMAIN INDEX TRIGGER CONSTRAINT ACL COMMENT POLICY; do
        if [[ "$entry" == "$candidate "* ]]; then kind="$candidate"; break; fi
      done
      break
    fi
  done <<< "$diagnostic"
  failure "$stage (client-status=$status;$category;stdin-line=$line;toc-entry=$toc;object-kind=$kind)"
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
  timeout --kill-after=10s "$seconds" docker run --name "$source_container" --rm -i --network host -e PGDATABASE -e PGOPTIONS \
    --entrypoint /bin/sh "$image" -c \
    'client=$1; shift; printf "LB_SOURCE_CLIENT_START:%s\n" "$client" >&2; case "$client" in psql|pg_dump) "/usr/lib/postgresql/bin/$client" --dbname="$PGDATABASE" "$@";; pg_dumpall) /usr/lib/postgresql/bin/pg_dumpall --database="$PGDATABASE" "$@";; *) exit 1;; esac; status=$?; printf "LB_SOURCE_CLIENT_COMPLETE:%s:%s\n" "$client" "$status" >&2; exit "$status"' \
    source-client "$client" "$@"
}
source_catalog() { source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 < "$catalog"; }
startup_query="$(node "$startup_helper" query)" || failure 'numeric startup query unavailable'
source_startup() { source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 -c "$startup_query"; }
auth_versions() {
  source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
    -c 'SELECT jsonb_agg(version ORDER BY version) FROM auth.schema_migrations;'
}
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
source_startup >"$scratch/startup-before.json" 2>"$scratch/source-error.log" || source_failure 'source startup profile unavailable' "$scratch/source-error.log" "$?"
startup_config="$(node "$startup_helper" config "$scratch/startup-before.json")" || failure 'unsupported source numeric startup profile'
auth_versions >"$scratch/auth-versions-before.json" 2>"$scratch/source-error.log" || failure 'Auth migration metadata unavailable'
source_catalog >"$scratch/source-before.json" 2>"$scratch/source-error.log" || source_failure 'source catalog read unavailable' "$scratch/source-error.log" "$?"
source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$extension_trigger_bootstrap" >"$scratch/extension-triggers-before.sql" 2>"$scratch/source-error.log" || source_failure 'extension-table trigger metadata unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/extension-triggers-before.sql"
source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$acl_bootstrap" >"$scratch/acl-before.sql" 2>"$scratch/source-error.log" || source_failure 'source ACL metadata unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/acl-before.sql"
source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$definition_bootstrap" >"$scratch/definitions-before.sql" 2>"$scratch/source-error.log" || source_failure 'source definition metadata unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/definitions-before.sql"
# Run 37579107745 observed inner client status 0 and outer elapsed 514s.
# Preserve a finite measured command envelope, not a claimed inner duration.
source_client 600 pg_dump \
  --verbose --schema-only --create --format=custom --no-password --no-subscriptions --lock-wait-timeout=5s \
  >"$scratch/schema.dump" 2>"$scratch/dump-error.log" || source_failure 'schema-only export unavailable' "$scratch/dump-error.log" "$?"
source_client 180 pg_dumpall --roles-only --no-role-passwords --no-password \
  >"$scratch/roles.sql" 2>"$scratch/roles-error.log" || source_failure 'password-free role export unavailable' "$scratch/roles-error.log" "$?"
source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$extension_bootstrap" >"$scratch/extensions.sql" 2>"$scratch/source-error.log" || source_failure 'extension owner metadata unavailable' "$scratch/source-error.log" "$?"
source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$event_owner_bootstrap" >"$scratch/event-owners.json" 2>"$scratch/source-error.log" || source_failure 'event-trigger owner metadata unavailable' "$scratch/source-error.log" "$?"
source_catalog >"$scratch/source-after.json" 2>"$scratch/source-error.log" || source_failure 'source catalog recheck unavailable' "$scratch/source-error.log" "$?"
cmp -s "$scratch/source-before.json" "$scratch/source-after.json" || failure 'source schema changed during export'
source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$extension_trigger_bootstrap" >"$scratch/extension-triggers-after.sql" 2>"$scratch/source-error.log" || source_failure 'extension-table trigger metadata recheck unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/extension-triggers-after.sql"
cmp -s "$scratch/extension-triggers-before.sql" "$scratch/extension-triggers-after.sql" || failure 'extension-table trigger metadata changed during export'
source_client 180 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$acl_bootstrap" >"$scratch/acl-after.sql" 2>"$scratch/source-error.log" || source_failure 'source ACL metadata recheck unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/acl-after.sql"
cmp -s "$scratch/acl-before.sql" "$scratch/acl-after.sql" || failure 'source ACL metadata changed during export'
source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \
  <"$definition_bootstrap" >"$scratch/definitions-after.sql" 2>"$scratch/source-error.log" || source_failure 'source definition metadata recheck unavailable' "$scratch/source-error.log" "$?"
chmod 600 "$scratch/definitions-after.sql"
cmp -s "$scratch/definitions-before.sql" "$scratch/definitions-after.sql" || failure 'source definition metadata changed during export'
source_startup >"$scratch/startup-after.json" 2>"$scratch/source-error.log" || source_failure 'source startup profile recheck unavailable' "$scratch/source-error.log" "$?"
node "$startup_helper" verify "$scratch/startup-before.json" "$scratch/startup-after.json" || failure 'source numeric startup profile changed during export'
prepare_roles "$source_bootstrap" <"$scratch/roles.sql" >"$scratch/roles-restore.sql" || failure 'exact existing bootstrap role creation unavailable'
auth_versions >"$scratch/auth-versions-after.json" 2>"$scratch/source-error.log" || failure 'Auth migration metadata recheck unavailable'
cmp -s "$scratch/auth-versions-before.json" "$scratch/auth-versions-after.json" || failure 'Auth migration history changed during export'
unset DATABASE_URL PGDATABASE PGOPTIONS PGHOST PGUSER PGPASSWORD
docker network create --internal "$network" >"$scratch/network.log" 2>&1
# Bootstrap the official PostgreSQL image without its canned application schema.
# Live roles/schema are attempted below; ownership is proven only by readback.
# Each extension is created under its source owner. No external network is allowed.
docker run -d --name "$container" --network "$network" --user postgres --entrypoint bash "$image" -c \
  '/usr/lib/postgresql/bin/initdb -U "$1" -D /tmp/leaderboard-qualification-db >/tmp/init.log 2>&1 && printf "\n%s\n" "$2" >>/tmp/leaderboard-qualification-db/postgresql.conf && /usr/lib/postgresql/bin/pg_ctl -D /tmp/leaderboard-qualification-db -o "-c listen_addresses= -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements" -l /tmp/postgres.log -w start && exec sleep infinity' \
  isolated-bootstrap "$source_bootstrap" "$startup_config" \
  >"$scratch/container.log" 2>&1 || failure 'isolated runtime cannot start'
ready=false
for _ in {1..30}; do
  if docker exec "$container" pg_isready -h /tmp -U "$bootstrap" -d postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || failure 'isolated PostgreSQL did not become ready'
docker exec "$container" psql -h /tmp -XAtq -U "$source_bootstrap" -d template1 -v ON_ERROR_STOP=1 \
  -c "$startup_query" >"$scratch/startup-initial.json" 2>"$scratch/local-error.log" || failure 'initial isolated startup profile unavailable'
node "$startup_helper" verify "$scratch/startup-before.json" "$scratch/startup-initial.json" || failure 'initial isolated startup profile differs'
docker exec "$container" psql -h /tmp -Xq -U "$source_bootstrap" -d template1 -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE $bootstrap SUPERUSER LOGIN;" >"$scratch/bootstrap-create.log" 2>&1 || failure 'isolated qualification role creation failed'
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d template1 -v ON_ERROR_STOP=1 \
  -v VERBOSITY=verbose <"$scratch/roles-restore.sql" >"$scratch/role-restore.log" 2>&1 || failure "exact roles cannot be restored ($(destination_role_category <"$scratch/role-restore.log"))"
docker exec "$container" psql -h /tmp -Xq -U "$bootstrap" -d template1 -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c 'DROP DATABASE postgres;' >"$scratch/drop-empty-database.log" 2>&1 || destination_failure 'empty local database preparation failed' "$scratch/drop-empty-database.log" "$?"
docker run --rm -i --entrypoint /usr/lib/postgresql/bin/pg_restore "$image" --list --create \
  <"$scratch/schema.dump" >"$scratch/archive.list" 2>"$scratch/list-error.log" || failure 'archive ordering unavailable'
awk '$4 == "DATABASE" || ($4 == "ACL" && $6 == "DATABASE") {print}' "$scratch/archive.list" >"$scratch/database.list"
awk '$4 == "SCHEMA" {print}' "$scratch/archive.list" >"$scratch/schemas.list"
awk '$4 != "DATABASE" && !($4 == "ACL" && $6 == "DATABASE") && $4 != "SCHEMA" && $4 != "EXTENSION" {print}' \
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
docker exec "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 \
  -c "$startup_query" >"$scratch/startup-restarted.json" 2>"$scratch/local-error.log" || failure 'restarted isolated startup profile unavailable'
node "$startup_helper" verify "$scratch/startup-before.json" "$scratch/startup-restarted.json" || failure 'restarted isolated startup profile differs'
# The generated file contains catalog-quoted extension installation and default
# tablespace ownership statements, and is executed exclusively in isolation.
# Temporary installer privilege is transaction-scoped locally and restored to
# the original role attribute in that same transaction before any qualification.
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --file=- \
  <"$scratch/extensions.sql" >"$scratch/extension-restore.log" 2>&1 || destination_failure 'original-owner extensions or exact versions cannot be restored' "$scratch/extension-restore.log" "$?"
# Render the unchanged remaining archive privately. psql owns one transaction
# across elevation, archive restoration and exact original role attributes.
docker exec -i "$container" pg_restore --file=- --schema-only --exit-on-error --use-list=/tmp/remaining.list \
  <"$scratch/schema.dump" >"$scratch/remaining.sql" 2>"$scratch/schema-render.log" || destination_failure 'remaining archive rendering failed' "$scratch/schema-render.log" "$?"
node "$restore_script_helper" "$scratch/remaining.sql" "$scratch/event-owners.json" \
  "$scratch/event-owners-elevate.sql" "$scratch/event-owners-restore.sql" || failure 'atomic restore script validation failed'
# Stream host-private inputs; docker cp would preserve root-owned 0600 files
# unreadable to the destination's postgres OS user. One psql owns all inputs.
cat "$scratch/event-owners-elevate.sql" "$scratch/remaining.sql" "$scratch/extension-triggers-before.sql" "$scratch/definitions-before.sql" "$scratch/event-owners-restore.sql" \
  >"$scratch/atomic-restore.sql" || failure 'complete atomic restore input unavailable'
chmod 600 "$scratch/atomic-restore.sql"
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d postgres \
  -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --single-transaction \
  --file=- \
  <"$scratch/atomic-restore.sql" >"$scratch/schema-restore.log" 2>&1 || destination_failure 'schema incompatibility during isolated restore' "$scratch/schema-restore.log" "$?"
# Replay only exact owner-bound source ACLs in a separately guarded atomic
# transaction after original role attributes are restored. Full catalog equality
# remains mandatory; the generated input refuses unsupported grant chains.
docker exec -i "$container" psql -h /tmp -Xq -U "$bootstrap" -d postgres \
  -v ON_ERROR_STOP=1 -v VERBOSITY=verbose --file=- \
  <"$scratch/acl-before.sql" >"$scratch/acl-restore.log" 2>&1 || destination_failure 'exact source ACL restoration failed' "$scratch/acl-restore.log" "$?"
docker exec -i "$container" psql -h /tmp -XAtq -U "$bootstrap" -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  <"$catalog" >"$scratch/isolated.json" 2>"$scratch/local-error.log" || destination_failure 'isolated catalog readback failed' "$scratch/local-error.log" "$?"
# Fixed-section diagnostics retain no private identifiers or field values.
# They explain a refusal only; exact equality below remains authoritative.
if ! cmp -s "$scratch/source-before.json" "$scratch/isolated.json"; then
  node "$catalog_diagnostic" "$scratch/source-before.json" "$scratch/isolated.json" || echo 'Catalog Diagnostic Unavailable; Equality Still Refused.' >&2
fi
cmp -s "$scratch/source-before.json" "$scratch/isolated.json" || failure 'isolated catalog differs from current source'
hash="$(sha256sum "$scratch/isolated.json" | cut -d' ' -f1)"
# Actual Auth runs only AFTER full current catalog equivalence, BEFORE owner cleanup.
# Launcher performs exact local metadata insertion/readback; no Auth users copied.
node --input-type=module - "$container" "$scratch" <<'AUTH_INPUT' | node "$here/leaderboard-real-auth-launcher-draft.mjs" || failure 'isolated actual Auth qualification failed'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [container, scratch] = process.argv.slice(2);
const authVersions = JSON.parse(readFileSync(join(scratch, 'auth-versions-before.json'), 'utf8'));
process.stdout.write(JSON.stringify({ container, scratch, sourceCatalog: join(scratch, 'source-before.json'), authVersions }));
AUTH_INPUT
cleanup || failure 'explicit cleanup verification failed'
echo "Captured schema/security catalog coverage matched isolated restore and cleanup. Catalog SHA256: $hash"
echo 'Selected isolated Auth/REST authorization matrix and owner cleanup completed; production binary/config parity, payouts, recovery and worker qualification remain excluded.'
