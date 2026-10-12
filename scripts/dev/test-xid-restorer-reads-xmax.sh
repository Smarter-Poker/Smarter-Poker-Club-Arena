#!/usr/bin/env bash
# The xid restorer reads xmax: execute fn_ca_xid8 exactly as
# 20261002170824_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged
# installs it, on an isolated PostgreSQL 17, against the shape it misjudged in
# production: a leg committed while an OLDER transaction is still open. The
# old helper took its epoch from the snapshot's xmin and returned "the future"
# (18446744070211823064) for every xid above it, so the ledger replay judged a
# leg the previous reading HAD seen as unseen and counted it twice.
set -euo pipefail
export LC_ALL="${LC_ALL:-C}"
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/xid-restorer.XXXXXX")
started=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$fixture/server.log" ]; then cat "$fixture/server.log" >&2; fi
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m fast stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55498 -c listen_addresses=''" start >/dev/null
started=1
migration=$(ls "$root"/supabase/migrations/*_the_xid_restorer_reads_xmax_and_reading_779_is_acknowledged.sql | head -1)
q() { "$pgbin/psql" -h "$fixture/socket" -p 55498 -d postgres -X -q -v ON_ERROR_STOP=1 -At "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

python3 - "$migration" > "$fixture/xid8.sql" <<'PY'
import re, sys
sql = open(sys.argv[1]).read()
m = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_ca_xid8\(.*?\$function\$;', sql, re.S)
if not m:
    sys.exit('migration does not define public.fn_ca_xid8')
print(m.group(0))
PY
q -f "$fixture/xid8.sql"
q -c "CREATE TABLE legs (id bigserial PRIMARY KEY, amount numeric)"
q -c "CREATE TABLE readings (id bigserial PRIMARY KEY, snap text)"

# an OLDER transaction holds the snapshot's xmin back across two readings
q <<'SQL' &
BEGIN;
SELECT pg_current_xact_id();
SELECT pg_sleep(4);
COMMIT;
SQL
holder=$!
sleep 1
q -c "INSERT INTO legs (amount) VALUES (40)"
q -c "INSERT INTO readings (snap) SELECT pg_current_snapshot()::text"     # reading 1 sees the leg
restored=$(q -c "SELECT public.fn_ca_xid8(xmin)::text = xmin::text FROM legs")
[ "$restored" = "t" ] || fail "an xid above the oldest running transaction must restore to itself, got $(q -c "SELECT public.fn_ca_xid8(xmin) FROM legs")"
seen=$(q -c "SELECT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), r.snap::pg_snapshot) FROM legs l, readings r WHERE r.id = 1")
[ "$seen" = "t" ] || fail "reading 1 saw the leg; the restorer must say so while the older transaction is still open"
wait "$holder"
echo "ok - a leg committed under an older open transaction is judged visible to the reading that saw it (counted once)"

q -c "BEGIN; SELECT pg_current_xact_id(); INSERT INTO readings (snap) SELECT pg_current_snapshot()::text; COMMIT;" >/dev/null
q -c "INSERT INTO legs (amount) VALUES (7)"
unseen=$(q -c "SELECT NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), r.snap::pg_snapshot) FROM legs l, readings r WHERE r.id = 2 AND l.amount = 7")
[ "$unseen" = "t" ] || fail "a leg committed after a reading must be judged unseen by it"
echo "ok - a leg committed after a reading is judged unseen by it (counted by the next)"
frozen=$(q -c "SELECT public.fn_ca_xid8('2'::xid)::text")
[ "$frozen" = "2" ] || fail "the frozen sentinel must stay older than everything, got $frozen"
echo "ok - the frozen sentinel restores to itself"
