#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="${RUNNER_TEMP:-${PRIVATE_RECORD_HOSTING_WORK:-}}"
[ -n "$parent" ] && [ -d "$parent" ] || { echo 'Owned gateway access scratch required' >&2; exit 1; }
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
work="$(mktemp -d "$parent/gaccess.XXXXXX")"
trap '"$pgbin/pg_ctl" -D "$work/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57651" -w start >/dev/null
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57651 -U fixture_admin -d postgres <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
ALTER DATABASE postgres OWNER TO postgres;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT anon,authenticated TO postgres;
SQL
python3 - "$repo" "$work" <<'PY'
from pathlib import Path
import sys
repo, work = map(Path, sys.argv[1:])
source=(repo/'supabase/migrations/20261019152515_private_record_notifies_the_existing_engine_transport.sql').read_text()
start=source.index('CREATE FUNCTION public.fn_private_record_transport_ready()')
end=source.index('COMMIT;',start)
(work/'maintained-readiness.sql').write_text(source[start:end])
PY
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57651 -U postgres -d postgres)
"${psql[@]}" -f "$repo/scripts/ci/fixtures/private-record-gateway-access-setup.sql"
"${psql[@]}" -f "$repo/tests/fixtures/ev-cashout-lifecycle/player-session-access.sql"
"${psql[@]}" -f "$work/maintained-readiness.sql"
migration="$repo/supabase/migrations/20261029182443_private_record_gateway_checks_only_its_authenticated_session.sql"
# Ownership drift is a pre-install refusal, before either capability exists.
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57651 -U fixture_admin -d postgres -c 'ALTER FUNCTION public.fn_ca_player_session_live(uuid,uuid) OWNER TO fixture_admin'
if "${psql[@]}" -f "$migration" > "$work/preimage-refusal.log" 2>&1; then
 echo 'Gateway access ownership drift unexpectedly accepted' >&2; exit 1
fi
grep -q PRIVATE_RECORD_GATEWAY_ACCESS_PREIMAGE_CHANGED "$work/preimage-refusal.log"
[ "$("${psql[@]}" -At -c "SELECT to_regprocedure('public.fn_ca_private_record_gateway_session_live()') IS NULL AND to_regprocedure('public.fn_ca_private_record_gateway_ready()') IS NULL")" = t ]
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57651 -U fixture_admin -d postgres -c 'ALTER FUNCTION public.fn_ca_player_session_live(uuid,uuid) OWNER TO postgres'
"${psql[@]}" -f "$migration"
"${psql[@]}" -f "$repo/scripts/ci/fixtures/private-record-gateway-access-proof.sql"
if "${psql[@]}" -f "$migration" > "$work/replay.log" 2>&1; then
 echo 'Gateway access migration replay unexpectedly accepted' >&2; exit 1
fi
grep -q PRIVATE_RECORD_GATEWAY_ACCESS_ALREADY_EXISTS "$work/replay.log"
"${psql[@]}" -At -c "SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_ca_player_session_live','fn_private_record_transport_ready','fn_ca_private_record_gateway_session_live','fn_ca_private_record_gateway_ready')" > "$work/functions.json"
python3 - "$repo" "$work/functions.json" > "$work/receipt.json" <<'PYRECEIPT'
from pathlib import Path
import sys,json,hashlib
repo=Path(sys.argv[1])
paths=['scripts/ci/test-private-record-gateway-access-postgres.sh','scripts/ci/fixtures/private-record-gateway-access-setup.sql','scripts/ci/fixtures/private-record-gateway-access-proof.sql','tests/fixtures/ev-cashout-lifecycle/player-session-access.sql','supabase/migrations/20261019152515_private_record_notifies_the_existing_engine_transport.sql','supabase/migrations/20261029182443_private_record_gateway_checks_only_its_authenticated_session.sql']
print(json.dumps({'schema':1,'suite':'private-record-gateway-access','sourceHashes':{p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in paths},'functionMd5':json.loads(Path(sys.argv[2]).read_text()),'checks':{'sourcePreimage':True,'ownerDriftAtomicRefusal':True,'actorSession':True,'anonymousDenial':True,'sourceDrift':True,'replayRefusal':True}},sort_keys=True))
PYRECEIPT
receipt="$(cat "$work/receipt.json")"
"$pgbin/pg_ctl" -D "$work/data" -m immediate -w stop >/dev/null
rm -rf "$work"
trap - EXIT
printf 'PRIVATE_RECORD_GATEWAY_ACCESS_RECEIPT %s\n' "$receipt"
echo 'PRIVATE_RECORD_GATEWAY_ACCESS_POSTGRES PASS: actual actor/session/source/privilege and atomic refusal checks; native cluster stopped and removed'
