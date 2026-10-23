#!/usr/bin/env bash
# Native qualification of the daily-maintenance window route
# (scripts/ci/maintenance-window-migrations.mjs, apply-recorded-migration.mjs
# --maintenance-window, install-window-migrations.mjs) against a real
# PostgreSQL carrying production's break-window guard and freeze predicates.
#
# It runs the REAL applier and the REAL installer, over TLS verified against a
# throwaway CA, and proves:
#   1. the ordinary applier refuses a declared migration as QUEUED, sends nothing;
#   2. the window route refuses while no break is open, sends nothing;
#   3. a lock it cannot take at once rolls the whole install back in ~1 s,
#      with no history row, no override row and no column;
#   4. inside the open window it installs once, the DDL guard records the
#      override reason, and the history row carries the exact file bytes;
#   5. a second run is ALREADY-APPLIED and changes nothing;
#   6. a window too close to the thaw is refused at the opening assertion;
#   7. a transaction over its budget is rolled back by the closing assertion;
#   8. the installer: nothing queued exits 0 at once, a statically invalid file
#      is refused before any wait, a break that never opens is reported and
#      sends nothing, and an open break installs every queued file once.
#
# Usage: PG_BIN=/usr/lib/postgresql/17/bin bash scripts/ci/test-maintenance-window-migrations.sh
# Needs node with `pg` resolvable from scripts/ci (CI: npm i pg@8 --no-save).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="${WINDOW_WORK:-/var/tmp/pg-window}"
PORT="${WINDOW_PORT:-55444}"
EVIDENCE="${WINDOW_EVIDENCE:-$ROOT/artifacts/maintenance-window-migrations}"
FIXTURES="$ROOT/scripts/ci/fixtures/maintenance-window-migrations"

as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

rm -rf "$WORK"
mkdir -p "$WORK" "$EVIDENCE"
[ "$(id -u)" = 0 ] && chown postgres "$WORK"
DATA="$WORK/data"
TLS="$WORK/tls"
as_pg mkdir -p "$TLS"

# A throwaway CA and a localhost server certificate: the real pg client
# verifies the chain and the host name exactly as it does against Supabase.
as_pg openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=window-fixture-ca' \
  -keyout "$TLS/ca.key" -out "$TLS/ca.crt" >/dev/null 2>&1
as_pg openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$TLS/server.key" -out "$TLS/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$WORK/san.ext"
as_pg openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" \
  -CAcreateserial -days 1 -extfile "$WORK/san.ext" -out "$TLS/server.crt" >/dev/null 2>&1
as_pg chmod 600 "$TLS/server.key"
cp "$TLS/ca.crt" "$WORK/ca-public.crt"
chmod 644 "$WORK/ca-public.crt"

as_pg "$PG_BIN/initdb" -D "$DATA" -U supabase_admin --auth-local=trust --auth-host=scram-sha-256 >/dev/null
cat >> "$DATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$WORK'
ssl = on
ssl_cert_file = '$TLS/server.crt'
ssl_key_file = '$TLS/server.key'
EOF
as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$WORK/postgres.log" -w start >/dev/null
trap 'as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true' EXIT

SU=("$PG_BIN/psql" -X -q -h "$WORK" -p "$PORT" -U supabase_admin -d postgres -v ON_ERROR_STOP=1)
su_sql() { as_pg "${SU[@]}" -Atc "$1"; }
as_pg "${SU[@]}" -f "$FIXTURES/schema.sql" >/dev/null

export DATABASE_URL="postgres://postgres:window-fixture@localhost:$PORT/postgres"
export PSQL_BIN="$PG_BIN/psql"
CA="$WORK/ca-public.crt"
SERVER_VERSION="$(su_sql 'SHOW server_version_num')"

# The fixture migrations live in a scratch checkout layout: the applier reads
# supabase/migrations relative to its working directory.
CASE="$WORK/case"
mkdir -p "$CASE/supabase/migrations"
cp "$FIXTURES/20991231000001_window_fixture_takes_the_live_tables.sql" "$CASE/supabase/migrations/"
FIRST=20991231000001_window_fixture_takes_the_live_tables.sql

apply() { (cd "$CASE" && node "$ROOT/scripts/ci/apply-recorded-migration.mjs" --ssl-root-cert "$CA" --migration "$@"); }
fail() { echo "FAIL: $*" | tee -a "$EVIDENCE/result.txt"; exit 1; }
pass() { echo "PASS: $*" | tee -a "$EVIDENCE/result.txt"; }
: > "$EVIDENCE/result.txt"
echo "server_version_num=$SERVER_VERSION" | tee -a "$EVIDENCE/result.txt"
counts() {
  su_sql "SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations)
          || ' ' || (SELECT count(*) FROM public.ca_break_window_migration_overrides)
          || ' ' || (SELECT count(*) FROM information_schema.columns
                      WHERE table_schema = 'public' AND column_name LIKE 'window_fixture_%')"
}

# 1. The ordinary applier refuses it as queued. Its own clock is moved to
# minute :20 of this hour, so the run does not depend on landing outside the
# :50-:03 refusal that would otherwise answer first.
OUTSIDE_BREAK_MINUTE="$(node -e 'const h=Math.floor(Date.now()/3600000)*3600000; process.stdout.write(String(h+20*60000))')"
set +e
out="$(cd "$CASE" && FAKE_NOW_MS="$OUTSIDE_BREAK_MINUTE" node --import "$FIXTURES/shift-clock.mjs" \
  "$ROOT/scripts/ci/apply-recorded-migration.mjs" --ssl-root-cert "$CA" --migration "$FIRST" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/1-ordinary-applier.log"
[ "$code" = 1 ] || fail "ordinary applier exit $code, expected 1"
grep -q 'It is QUEUED, not lost' <<<"$out" || fail 'ordinary applier did not say QUEUED'
[ "$(counts)" = "0 0 0" ] || fail "ordinary applier changed state: $(counts)"
pass 'the ordinary applier refuses a declared migration as QUEUED and sends nothing'

# 2. The window route refuses while no break is open.
set +e
out="$(apply "$FIRST" --maintenance-window 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/2-window-closed.log"
[ "$code" = 1 ] || fail "closed window exit $code, expected 1"
grep -q 'daily maintenance window is not open' <<<"$out" || fail 'closed window gave no reason'
[ "$(counts)" = "0 0 0" ] || fail "closed window changed state: $(counts)"
pass 'the window route refuses outside an open break and sends nothing'

# 3. A lock that is not free: refused and rolled back at once, never queued.
su_sql 'SELECT public.fixture_open_window(240)' >/dev/null
as_pg "${SU[@]}" -c "BEGIN; LOCK TABLE public.hand_history IN ACCESS SHARE MODE; SELECT pg_sleep(20); COMMIT;" \
  >/dev/null 2>&1 &
HOLDER=$!
for _ in $(seq 1 50); do
  held="$(su_sql "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                  WHERE c.relname = 'hand_history' AND l.granted AND l.pid <> pg_backend_pid()")"
  [ "$held" -ge 1 ] && break
  sleep 0.1
done
[ "$held" -ge 1 ] || fail 'could not hold the fixture lock'
t0=$(date +%s%N)
set +e
out="$(apply "$FIRST" --maintenance-window 2>&1)"; code=$?
set -e
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
echo "$out" > "$EVIDENCE/3-lock-unavailable.log"
kill "$HOLDER" 2>/dev/null || true
su_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(20)%' AND pid <> pg_backend_pid()" >/dev/null
wait "$HOLDER" 2>/dev/null || true
[ "$code" = 1 ] || fail "lock unavailable exit $code, expected 1 (REFUSED)"
grep -q '55P03' <<<"$out" || fail 'lock unavailable did not report lock_not_available (55P03)'
[ "$ms" -lt 6000 ] || fail "lock unavailable took ${ms}ms; it must refuse, not wait"
[ "$(counts)" = "0 0 0" ] || fail "lock unavailable left state: $(counts)"
pass "a lock that is not free rolls the install back in ${ms} ms with nothing left behind"

# 4. Inside the open window it installs, once, with the override recorded.
set +e
out="$(apply "$FIRST" --maintenance-window 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/4-install.log"
[ "$code" = 0 ] || fail "install exit $code: $out"
grep -q '\[apply\] APPLIED' <<<"$out" || fail 'install did not report APPLIED'
[ "$(counts)" = "1 1 1" ] || fail "install state: $(counts)"
reason="$(su_sql "SELECT reason || ' | ' || session_role || ' | ' || coalesce(application_name, '') FROM public.ca_break_window_migration_overrides")"
echo "$reason" > "$EVIDENCE/4-override.txt"
grep -q "daily-maintenance window install of $FIRST" <<<"$reason" || fail "override reason: $reason"
grep -q '| postgres | apply-recorded-migration' <<<"$reason" || fail "override actor: $reason"
same="$(su_sql "SELECT statements[1] = pg_read_file('$CASE/supabase/migrations/$FIRST') FROM supabase_migrations.schema_migrations WHERE version = '20991231000001'")"
[ "$same" = t ] || fail 'history row does not carry the exact file bytes'
pass 'inside the open window it installs once, records the override reason and the exact history'

# 5. A second run is a no-op.
set +e
out="$(apply "$FIRST" --maintenance-window 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/5-second-run.log"
[ "$code" = 0 ] || fail "second run exit $code"
grep -q 'ALREADY-APPLIED' <<<"$out" || fail 'second run was not ALREADY-APPLIED'
[ "$(counts)" = "1 1 1" ] || fail "second run changed state: $(counts)"
pass 'a second run is ALREADY-APPLIED and changes nothing'

# 6 and 7 run the generated transaction directly, as the migrating role.
gen() {
  node --input-type=module -e "
    import { windowTransactionSQL } from '$ROOT/scripts/ci/maintenance-window-migrations.mjs';
    import { readFileSync } from 'node:fs';
    process.stdout.write(windowTransactionSQL(process.argv[1], readFileSync(0, 'utf8')));
  " "$1"
}
run_as_migrator() {
  PGPASSWORD=window-fixture PGSSLMODE=verify-full PGSSLROOTCERT="$CA" PGAPPNAME=apply-recorded-migration \
    "$PG_BIN/psql" -X -q -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$1"
}

# 6. Too close to the thaw: the opening assertion refuses.
su_sql 'SELECT public.fixture_open_window(120)' >/dev/null
printf 'BEGIN;\nALTER TABLE public.tables ADD COLUMN window_fixture_late int;\nCOMMIT;\n' \
  | gen 20991231000009_window_fixture_late.sql > "$WORK/late.sql"
set +e
out="$(run_as_migrator "$WORK/late.sql" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/6-too-close-to-thaw.log"
[ "$code" != 0 ] || fail 'a window 120 s from its end admitted an install'
grep -q 'install_window_closed' <<<"$out" || fail "late window reason: $out"
[ "$(counts)" = "1 1 1" ] || fail "late window changed state: $(counts)"
pass 'a window with less than the start reserve left refuses at the opening assertion'

# 7. Over budget: the closing assertion rolls it back.
su_sql 'SELECT public.fixture_open_window(240)' >/dev/null
printf 'BEGIN;\nALTER TABLE public.tables ADD COLUMN window_fixture_slow int;\nSELECT pg_sleep(4.6);\nSELECT pg_sleep(4.6);\nCOMMIT;\n' \
  | gen 20991231000008_window_fixture_slow.sql > "$WORK/slow.sql"
set +e
out="$(run_as_migrator "$WORK/slow.sql" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/7-over-budget.log"
[ "$code" != 0 ] || fail 'an install over its budget committed'
grep -Eq 'install_window_budget_exceeded|transaction timeout' <<<"$out" || fail "over budget reason: $out"
[ "$(counts)" = "1 1 1" ] || fail "over budget changed state: $(counts)"
pass 'an install over its budget is rolled back by the closing assertion'

# 8. The installer.
installer() {
  (cd "$1" && FAKE_NOW_MS="$2" node --import "$FIXTURES/shift-clock.mjs" \
     "$ROOT/scripts/ci/install-window-migrations.mjs" --ssl-root-cert "$CA")
}
chicago_four() { # epoch ms of the most recent 04:00 America/Chicago, plus $1 seconds
  node --input-type=module -e "
    const { dailyWindows } = await import('$ROOT/scripts/ci/maintenance-window-migrations.mjs');
    const w = dailyWindows(Date.now()).filter((x) => x.startsAt <= Date.now()).pop();
    process.stdout.write(String(w.startsAt + Number(process.argv[1]) * 1000));
  " "$1"
}
NOW_OPEN="$(chicago_four 5)"
NOW_LATE="$(chicago_four 146)"

# 8a. Everything recorded: exits 0 at once.
set +e
out="$(installer "$CASE" "$NOW_OPEN" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/8a-nothing-queued.log"
[ "$code" = 0 ] && grep -q 'NOTHING QUEUED' <<<"$out" || fail "nothing-queued run: $code $out"
pass 'the installer exits at once when nothing is queued'

# 8b. A statically invalid queued file is refused before any wait.
BAD="$WORK/bad"
mkdir -p "$BAD/supabase/migrations"
cp "$FIXTURES/20991231000003_window_fixture_waits_too_long.sql" "$BAD/supabase/migrations/"
set +e
out="$(installer "$BAD" "$NOW_OPEN" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/8b-invalid-before-wait.log"
[ "$code" = 1 ] && grep -q 'REFUSED before waiting' <<<"$out" || fail "invalid file run: $code $out"
pass 'a queued file that breaks the window rules is refused before any wait'

# 8c. The break never opens: reported, nothing sent.
cp "$FIXTURES/20991231000002_window_fixture_second_live_table.sql" "$CASE/supabase/migrations/"
su_sql 'SELECT public.fixture_close_window()' >/dev/null
set +e
out="$(installer "$CASE" "$NOW_LATE" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/8c-never-opened.log"
[ "$code" = 1 ] && grep -q 'BREAK NEVER OPENED' <<<"$out" || fail "never-opened run: $code $out"
[ "$(counts)" = "1 1 1" ] || fail "never-opened run changed state: $(counts)"
pass 'a break that never reaches a confirmed freeze is reported and nothing is sent'

# 8d. An open break: the queued file installs, once.
su_sql 'SELECT public.fixture_open_window(240)' >/dev/null
set +e
out="$(installer "$CASE" "$NOW_OPEN" 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/8d-installs.log"
[ "$code" = 0 ] && grep -q 'INSTALLED 1 migration' <<<"$out" || fail "installer run: $code $out"
[ "$(counts)" = "2 2 2" ] || fail "installer state: $(counts)"
set +e
out="$(installer "$CASE" "$NOW_OPEN" 2>&1)"; code=$?
set -e
echo "$out" >> "$EVIDENCE/8d-installs.log"
[ "$code" = 0 ] && grep -q 'NOTHING QUEUED' <<<"$out" || fail "installer rerun: $code $out"
[ "$(counts)" = "2 2 2" ] || fail "installer rerun changed state: $(counts)"
pass 'the installer installs every queued file once inside the open break, and a rerun is a no-op'

# 9. A later explicit owner exception uses the SAME applier and transaction,
# at the real daytime clock. A scheduled or unowned freeze grants nothing.
OWNER_FILE=20991231000004_window_fixture_owner_exception.sql
sed 's/window_fixture_rake_cap/window_fixture_owner_exception/g' "$FIXTURES/$FIRST" > "$CASE/supabase/migrations/$OWNER_FILE"
mkdir -p "$CASE/server/release"
git -C "$CASE" init -q
# Disposable fixture identity, never the production repository or a person.
git -C "$CASE" -c user.name=WindowFixture -c user.email=window-fixture@example.invalid commit -q --allow-empty -m 'native owner-window fixture'
OWNER_HEAD="$(git -C "$CASE" rev-parse HEAD)"
OWNER_HEAD="$OWNER_HEAD" OWNER_FILE="$OWNER_FILE" OWNER_CASE="$CASE" node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
const at=Date.now();
writeFileSync(process.env.OWNER_CASE+'/server/release/owner-maintenance-windows.json', JSON.stringify({version:1,windows:[{
 id:'native-owner-proof',contains:process.env.OWNER_HEAD,ownerOrder:"Native fixture only: publish now, don't wait",
 notBefore:new Date(at-60000).toISOString(),notAfter:new Date(at+3600000).toISOString(),migrations:[process.env.OWNER_FILE]
}]}));
JS
# An isolated scratch Git identity proves the real ancestry check.
# No protected-main or production state is modified.
owner_apply() { apply "$OWNER_FILE" --maintenance-window --owner-window native-owner-proof; }
su_sql "SELECT public.fixture_open_window(240); UPDATE public.engine_maintenance_break SET break_started_at=clock_timestamp()-interval '1 second', announced_at=clock_timestamp()-interval '2 minutes';" >/dev/null
set +e
out="$(owner_apply 2>&1)"; code=$?
set -e
echo "$out" > "$EVIDENCE/9-owner-window.log"
[ "$code" = 1 ] || fail "ordinary scheduled freeze admitted owner exception: $code $out"
[ "$(counts)" = "2 2 2" ] || fail 'refused owner install changed state'
su_sql "UPDATE public.engine_maintenance_break SET reason='Deployment Recovery';" >/dev/null
set +e
out="$(owner_apply 2>&1)"; code=$?
set -e
echo "$out" >> "$EVIDENCE/9-owner-window.log"
[ "$code" = 0 ] || fail "owner window install failed: $code $out"
[ "$(counts)" = "3 3 3" ] || fail "owner install state: $(counts)"
out="$(owner_apply 2>&1)" || fail "owner repeat failed: $out"
[ "$(counts)" = "3 3 3" ] || fail 'owner repeat changed state'
pass 'explicit owner exception refuses a scheduled freeze, installs once in owned recovery, and duplicate is a no-op'

su_sql "SELECT version || ' ' || name FROM supabase_migrations.schema_migrations ORDER BY version" \
  > "$EVIDENCE/history.txt"
su_sql "SELECT id || ' ' || session_role || ' ' || coalesce(application_name, '') || ' ' || first_command || ' :: ' || reason FROM public.ca_break_window_migration_overrides ORDER BY id" \
  > "$EVIDENCE/overrides.txt"
echo 'ALL PASS' | tee -a "$EVIDENCE/result.txt"
