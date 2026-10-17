#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/pilot-assignment.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55591 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -h "$scratch" -p 55591 -d postgres -v ON_ERROR_STOP=1)
migration="$root/supabase/migrations/20261017043748_lightning_pilot_assignment_blocks_new_automated_tournament_e.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-pilot-assignment.sql" >/dev/null
if "${psql[@]}" -c 'SELECT witness.assert_refused();' >"$scratch/before.log" 2>&1; then echo 'FAIL predecessor admitted no horse'; exit 1; fi
grep -q 'ASSIGNED_HORSE_ADMITTED' "$scratch/before.log"
if "${psql[@]}" -c "DO \$\$ BEGIN IF fn_seat_horse_in_seat_first_game('80000000-0000-0000-0000-000000000001','0097309f-2864-4d09-b02b-56bca012a9c3')->>'reason' IS DISTINCT FROM 'lightning_pilot_assigned' THEN RAISE EXCEPTION 'ASSIGNED_SEAT_ADMITTED'; END IF; END \$\$;" >"$scratch/before-seat.log" 2>&1; then echo 'FAIL predecessor seat not reproduced'; exit 1; fi
grep -q 'ASSIGNED_SEAT_ADMITTED' "$scratch/before-seat.log"
echo 'PASS before: full actual entry predecessors admit assigned horse'


"${psql[@]}" -c "ALTER FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean) IMMUTABLE;" >/dev/null
if "${psql[@]}" -f "$migration" >"$scratch/wrong.log" 2>&1; then echo 'FAIL wrong predecessor accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/wrong.log"
test "$("${psql[@]}" -Atc "SELECT to_regclass('lightning_pilot_assignment') IS NULL")" = t
"${psql[@]}" -c "ALTER FUNCTION fn_register_horse_for_tournament(uuid,uuid,boolean) VOLATILE;" >/dev/null
"${psql[@]}" -f "$migration" >/dev/null
# Readiness identifies the exact qualified fleet-input control; common play
# remains covered by the broad source guard. No control is invoked here.
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-readiness-fleet-predecessor.sql" >/dev/null
"${psql[@]}" -c "DO \$\$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END \$\$; ALTER FUNCTION fn_lightning_rollout_readiness(uuid) OWNER TO postgres; REVOKE ALL ON FUNCTION fn_lightning_rollout_readiness(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION fn_lightning_rollout_readiness(uuid) TO authenticated,service_role;" >/dev/null
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-readiness-fleet-assertions.sql" >/dev/null
readiness_migration="$root/supabase/migrations/20261017072701_lightning_readiness_recognizes_exact_authorized_fleet_contro.sql"
# A wrong authority preimage refuses atomically and leaves the actual law false.
"${psql[@]}" -c "ALTER FUNCTION fn_lightning_rollout_readiness(uuid) VOLATILE;" >/dev/null
if "${psql[@]}" -f "$readiness_migration" >"$scratch/readiness-wrong.log" 2>&1; then echo 'FAIL readiness wrong predecessor accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/readiness-wrong.log"
"${psql[@]}" -c "ALTER FUNCTION fn_lightning_rollout_readiness(uuid) STABLE;" >/dev/null
"${psql[@]}" -c "ALTER FUNCTION fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text) STABLE;" >/dev/null
if "${psql[@]}" -f "$readiness_migration" >"$scratch/readiness-control-wrong.log" 2>&1; then echo 'FAIL readiness changed control preimage accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/readiness-control-wrong.log"
"${psql[@]}" -c "ALTER FUNCTION fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text) VOLATILE;" >/dev/null
"${psql[@]}" -f "$readiness_migration" >/dev/null
"${psql[@]}" -Atc "SELECT 'Readiness postimage MD5: '||md5(pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure));"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-readiness-fleet-after.sql" >/dev/null
if "${psql[@]}" -f "$readiness_migration" >"$scratch/readiness-replay.log" 2>&1; then echo 'FAIL readiness replay accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/readiness-replay.log"
echo 'PASS readiness actual guard before-false/after-true; unknown functions/control revisions refused; comments stripped; wrong predecessor/replay refused'

"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-pilot-assignment-assertions.sql" >/dev/null
if "${psql[@]}" -c 'SELECT witness.unsafe_lifecycle_withdrawal();' >"$scratch/before-race.log" 2>&1; then echo 'FAIL lifecycle race not reproduced'; exit 1; fi
grep -q 'WRONG_LIFECYCLE_WITHDRAWN' "$scratch/before-race.log"
echo 'PASS unchanged normal self door reproduces stale caller lifecycle at explicit financial boundary'

if "${psql[@]}" -f "$migration" >"$scratch/replay.log" 2>&1; then echo 'FAIL replay accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/replay.log"
echo 'PASS after: exact assignment on/off; free entries refused; existing commitments/tickets preserved; owner/session/input/replay/interruption/ACL guards'


# Admission holds a shared transaction lock through its complete delegate.
# An exclusive toggle cannot overtake it; its timed-out transaction has no receipt.
"${psql[@]}" >"$scratch/shared.log" 2>&1 <<SQL &
BEGIN;
SELECT fn_lightning_pilot_assignment_blocks('0097309f-2864-4d09-b02b-56bca012a9c3','80000000-0000-0000-0000-000000000001');
\! touch "$scratch/shared-ready"
SELECT pg_sleep(2);
COMMIT;
SQL
holder=$!
for i in {1..40}; do test -e "$scratch/shared-ready" && break; sleep 0.05; done
test -e "$scratch/shared-ready"
if "${psql[@]}" >"$scratch/lock.log" 2>&1 <<SQL
SET lock_timeout='100ms';
SELECT set_config('request.jwt.claim.sub','2d1cd6c3-5700-4af9-a271-d4863fdab20d',false);
SELECT set_config('witness.live','true',false);
SELECT fn_lightning_pilot_assignment_set(false,'70000000-0000-0000-0000-000000000030','121f80d2529012e532b4d3a702e2772cde9aa7778a82df26f5a02082d2b0ba8a',fn_lightning_pilot_assignment_players(),'native serialized toggle');
SQL
then echo 'FAIL: toggle overtook admission'; exit 1; fi
grep -q 'lock timeout' "$scratch/lock.log"
wait "$holder"
test "$("${psql[@]}" -Atc "SELECT count(*) FROM lightning_pilot_assignment_receipts WHERE request_id='70000000-0000-0000-0000-000000000030'")" = 0
echo 'PASS shared admission / exclusive toggle serialization; timeout leaves no receipt'
