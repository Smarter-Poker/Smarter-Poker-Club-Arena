#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="${RUNNER_TEMP:-${PRIVATE_RECORD_HOSTING_WORK:-}}"
[ -n "$parent" ] && [ -d "$parent" ] || { echo 'Owned credential qualification scratch required' >&2; exit 1; }
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$pgbin/initdb" ] && [ -x "$repo/server/node_modules/.bin/tsx" ]
work="$(mktemp -d "$parent/gcred.XXXXXX")"
trap '"$pgbin/pg_ctl" -D "$work/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=scram-sha-256 --no-locale -E UTF8 >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/server.key" -out "$work/server.crt" -days 1 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' > "$work/certificate.log" 2>&1
chmod 600 "$work/server.key"
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h 127.0.0.1 -k '$work/socket' -p 57649 -c ssl=on -c ssl_cert_file='$work/server.crt' -c ssl_key_file='$work/server.key'" -w start >/dev/null || { cat "$work/postgres.log"; exit 1; }
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57649 -U fixture_admin -d postgres -c "CREATE ROLE postgres LOGIN CREATEROLE NOSUPERUSER; ALTER DATABASE postgres OWNER TO postgres"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57649 -U postgres -d postgres -f "$repo/supabase/migrations/20261028154533_private_record_listener_has_a_dedicated_disabled_role.sql"
"$repo/server/node_modules/.bin/tsx" "$repo/scripts/ci/fixtures/private-record-credentials-postgres.mjs" "$work/socket" "$work/server.crt"
if "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57649 -U postgres -d postgres -f "$repo/supabase/migrations/20261028154533_private_record_listener_has_a_dedicated_disabled_role.sql" > "$work/replay.log" 2>&1; then
  echo 'Dedicated role migration replay unexpectedly accepted' >&2; exit 1
fi
if ! grep -q PRIVATE_RECORD_ROLE_ALREADY_EXISTS "$work/replay.log"; then cat "$work/replay.log"; exit 1; fi
echo 'PRIVATE_RECORD_CREDENTIAL_POSTGRES PASS: NOSUPERUSER CREATEROLE creator/ADMIN, disabled role, PUBLIC denial, verified TLS/SCRAM, LISTEN, replay ownership and no rotation'
