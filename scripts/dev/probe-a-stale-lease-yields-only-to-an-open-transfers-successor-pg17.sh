#!/usr/bin/env bash
# A STALE LEASE YIELDS ONLY TO AN OPEN TRANSFER'S SUCCESSOR - PostgreSQL 17 gate.
#
# Runs every claim_tournament_lease_v2 scenario in
# scripts/dev/fixtures/a-stale-lease-yields-only-to-an-open-transfers-successor
# against three bodies, in a disposable cluster:
#
#   main  20260918053310's body (the last one on main before 2026-09-27): the
#         open transfer's successor is refused by a dead holder forever - the
#         2026-09-26 "Standing down" stall;
#   live  the body production runs as of 2026-09-28 (20260927231300, captured
#         byte-exact: its pg_get_functiondef md5 must be 14f4ed4a...): the
#         successor is admitted, and so is ANY other instance asking for a
#         stale row's own generation - a shared fence token;
#   post  20260928032017: the successor of an OPEN transfer for this event is
#         admitted and nothing else is.
#
# The migration must apply over the live body, must refuse over main's body
# and over its own postimage (preimage guard), and must leave the body it
# refused untouched. No database URL is accepted; nothing outside the
# temporary directory is touched.
set -euo pipefail
export LC_ALL=C LANG=C PGTZ=UTC

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo/scripts/dev/fixtures/a-stale-lease-yields-only-to-an-open-transfers-successor"
migration="$repo/supabase/migrations/20260928032017_a_stale_lease_yields_only_to_an_open_transfers_successor.sql"
main_source="$repo/supabase/migrations/20260918053310_interrupted_sng_hands_keep_stacks_and_fence_their_original_writers.sql"
live_preimage="$fixture/live-preimage-2026-09-28.sql"
LIVE_DEF_MD5=14f4ed4a7659d42188f57da0a54af421
LIVE_SRC_MD5=e3397fe6782ed685d3aba81f547bb42c

if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/initdb ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  elif [[ -x /usr/lib/postgresql/17/bin/initdb ]]; then
    PGBIN=/usr/lib/postgresql/17/bin
  else
    echo "PostgreSQL 17 tools are required; set PGBIN to their bin directory." >&2
    exit 2
  fi
fi
case "$("$PGBIN/postgres" --version)" in
  "postgres (PostgreSQL) 17."*) ;;
  *) echo "This gate requires PostgreSQL 17." >&2; exit 2 ;;
esac
for f in "$migration" "$main_source" "$live_preimage" "$fixture/bootstrap.sql" "$fixture/scenarios.sql"; do
  test -f "$f" || { echo "missing $f" >&2; exit 2; }
done

root="$(mktemp -d "${TMPDIR:-/tmp}/ca-stale-lease-successor-pg17.XXXXXX")"
port="$((46432 + $$ % 10000))"
cleanup() {
  "$PGBIN/pg_ctl" -D "$root/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
mkdir "$root/socket"
"$PGBIN/initdb" -D "$root/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$root/data" -l "$root/postgres.log" \
  -o "-h '' -k '$root/socket' -p $port" -w start >/dev/null

psql_db() {
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$root/socket" -p "$port" -U postgres -d postgres "$@"
}
body_md5() {
  psql_db -At -c "SELECT md5(pg_get_functiondef(p.oid)) || ' ' || md5(p.prosrc) || ' ' || p.proacl::text FROM pg_proc p WHERE p.oid = 'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure"
}
install_body() {
  local sql="$1"
  psql_db -f "$sql"
  psql_db -c "REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;"
}
scenarios() {
  psql_db -v stage="$1" -f "$fixture/scenarios.sql" 2>&1 | sed "s/^/  /"
  local rc="${PIPESTATUS[0]}"
  if [[ "$rc" -ne 0 ]]; then echo "FAIL: scenarios on the $1 body" >&2; exit 1; fi
}
expect_refused() {
  local label="$1" before after out
  before="$(body_md5)"
  if out="$(psql_db -f "$migration" 2>&1)"; then
    echo "FAIL: the migration applied over $label" >&2; exit 1
  fi
  grep -q 'STALE_LEASE_SUCCESSOR_PREIMAGE_CHANGED' <<<"$out" \
    || { echo "FAIL: over $label the migration failed for another reason: $out" >&2; exit 1; }
  after="$(body_md5)"
  [[ "$before" == "$after" ]] || { echo "FAIL: a refused migration changed the body over $label" >&2; exit 1; }
  echo "ok: the migration refuses $label and leaves it untouched"
}

psql_db -f "$fixture/bootstrap.sql"

echo "== main (20260918053310)"
awk '/^CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2\(/{c=1} c{print} c && /^\$function\$;$/{exit}' \
  "$main_source" >"$root/main-body.sql"
grep -q 'lease_generation IS DISTINCT FROM EXCLUDED.lease_generation' "$root/main-body.sql" \
  || { echo "could not extract main's body" >&2; exit 2; }
install_body "$root/main-body.sql"
scenarios main
expect_refused "main's body"

echo "== live (production 2026-09-28)"
install_body "$live_preimage"
read -r def src acl <<<"$(body_md5)"
[[ "$def" == "$LIVE_DEF_MD5" && "$src" == "$LIVE_SRC_MD5" ]] \
  || { echo "FAIL: the captured live body is not production's ($def $src)" >&2; exit 1; }
[[ "$acl" == '{postgres=X/postgres,service_role=X/postgres}' ]] \
  || { echo "FAIL: live ACL $acl" >&2; exit 1; }
echo "ok: live body matches production md5 $def / $src"
scenarios live

echo "== post (20260928032017)"
psql_db -f "$migration"
read -r def src acl <<<"$(body_md5)"
echo "ok: migration applied; postimage $def / $src $acl"
scenarios post
expect_refused "its own postimage"

echo "PASS: a stale lease yields only to an open transfer's named successor"
