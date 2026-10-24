#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/midway-cash.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/log" -o "-k $scratch -p 55631 -c listen_addresses=''" start >/dev/null || { cat "$scratch/log"; exit 1; }
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55631 -d postgres -v ON_ERROR_STOP=1)
for file in lightning-five-ready-schema lightning-five-ready-group-preimage lightning-five-ready-preimages; do
 "${psql[@]}" -f "$root/scripts/dev/fixtures/$file.sql"
done
"${psql[@]}" -f "$root/supabase/migrations/20261023230001_classic_and_lightning_five_ready_waits_three_seconds_for_six.sql"
for file in lightning-canonical-admission-schema lightning-canonical-admission-preimages lightning-canonical-transition-schema lightning-canonical-retirement-schema lightning-canonical-cashout-preimages lightning-canonical-reversion-preimage lightning-canonical-projection-preimages lightning-canonical-transition-preimages lightning-canonical-pineapple; do
 "${psql[@]}" -f "$root/scripts/dev/fixtures/$file.sql"
done
"${psql[@]}" -f "$root/supabase/migrations/20261023230807_canonical_lightning_pools_preserve_custody.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/midway-union-cash-preimages.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/midway-union-cash-catalog.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/midway-union-cash-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/midway-union-context-preimage.sql"
migration="$root/supabase/migrations/20261024053530_midway_union_owns_member_cash_launches.sql"
# The original machine authority currently returns the member-hosted game.
original=$("${psql[@]}" -Atc "SELECT fn_cash_game_ensure('946747c6-b991-4220-b0cb-effbea46ecd2','nlh',.5,1,'classic',9)")
[ "$original" = 13b27cf7-dce5-4758-ac8b-914d824ca792 ] || { echo 'FAIL: original member-host reproduction changed'; exit 1; }
echo 'RED reproduced: original ensure admits the member-hosted game'
# Custody arriving before installation must abort the entire transaction, including function DDL.
"${psql[@]}" -c "INSERT INTO table_seats(table_id,user_id,seat_number,stack) VALUES(md5('13b27cf7-dce5-4758-ac8b-914d824ca792:fixture-table')::uuid,'90000000-0000-4000-8000-000000000090',1,100)"
if "${psql[@]}" -f "$migration" >"$scratch/refused.log" 2>&1; then echo 'FAIL: occupied source admitted'; exit 1; fi
grep -q 'Savage game has live custody or reservations' "$scratch/refused.log"
[ "$("${psql[@]}" -Atc "SELECT position('MIDWAY_UNION_HOST_ONLY' IN pg_get_functiondef('fn_cash_game_ensure(uuid,text,numeric,numeric,text,integer)'::regprocedure))")" = 0 ] || { echo 'FAIL: partial function DDL survived refusal'; exit 1; }
"${psql[@]}" -c "DELETE FROM table_seats WHERE user_id='90000000-0000-4000-8000-000000000090'"
refuse_custody() {
 local insert="$1" erase="$2" label="$3"
 "${psql[@]}" -c "$insert"
 if "${psql[@]}" -f "$migration" >"$scratch/refused.log" 2>&1; then echo "FAIL: $label admitted"; exit 1; fi
 grep -q 'Savage game has live custody or reservations' "$scratch/refused.log"
 "${psql[@]}" -c "$erase"
 echo "PASS: $label refuses the complete transaction"
}
source_id=13b27cf7-dce5-4758-ac8b-914d824ca792
source_table="md5('$source_id:fixture-table')::uuid"
refuse_custody "INSERT INTO hand_state_snapshots(table_id,is_complete,updated_at) VALUES($source_table,false,clock_timestamp())" "DELETE FROM hand_state_snapshots WHERE table_id=$source_table" 'unfinished original hand'
refuse_custody "INSERT INTO lightning_pool_session(cluster_id) VALUES('$source_id')" "DELETE FROM lightning_pool_session WHERE cluster_id='$source_id'" 'open pool custody'
refuse_custody "INSERT INTO lightning_instance(id,cluster_id,state) VALUES(gen_random_uuid(),'$source_id','forming')" "DELETE FROM lightning_instance WHERE cluster_id='$source_id'" 'forming pool instance'
refuse_custody "INSERT INTO lightning_reservation(cluster_id,state) VALUES('$source_id','pending')" "DELETE FROM lightning_reservation WHERE cluster_id='$source_id'" 'Lightning reservation'
refuse_custody "INSERT INTO cash_game_waitlist(game_id,user_id,status) VALUES('$source_id','90000000-0000-4000-8000-000000000090','notified')" "DELETE FROM cash_game_waitlist WHERE game_id='$source_id'" 'notified original seat hold'
refuse_custody "INSERT INTO cash_seat_moves(game_id,state) VALUES('$source_id','pending')" "DELETE FROM cash_seat_moves WHERE game_id='$source_id'" 'pending original move'
refuse_custody "INSERT INTO cash_player_session(id,cluster_id) VALUES(gen_random_uuid(),'$source_id')" "DELETE FROM cash_player_session WHERE cluster_id='$source_id'" 'open cash session'
refuse_custody "INSERT INTO cash_player_session(id,scope_id) VALUES(gen_random_uuid(),$source_table)" "DELETE FROM cash_player_session WHERE scope_id=$source_table" 'legacy scoped cash session'
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot=ruleset_snapshot||'{\"unexpected\":true}' WHERE id='$source_id'"
if "${psql[@]}" -f "$migration" >"$scratch/refused.log" 2>&1; then echo 'FAIL: changed source preimage admitted'; exit 1; fi
grep -q 'Savage empty-game preimage changed' "$scratch/refused.log"
"${psql[@]}" -c "UPDATE cash_games g SET ruleset_snapshot=b.ruleset_snapshot FROM fixture_midway_catalog_before b WHERE g.id=b.id AND g.id='$source_id'"
PGAPPNAME=midway-union-native-seat-lock "${psql[@]}" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('table_seat:'||($source_table)::text,0)); SELECT pg_sleep(30); COMMIT" >"$scratch/seat-lock.log" 2>&1 &
locker=$!
ready=0
for attempt in $(seq 1 100); do
 ready=$("${psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name='midway-union-native-seat-lock' AND wait_event='PgSleep'")
 [ "$ready" = 1 ] && break
 sleep .05
done
[ "$ready" = 1 ] || { echo 'FAIL: isolated seat-lock owner did not become ready'; exit 1; }
if "${psql[@]}" -f "$migration" >"$scratch/refused.log" 2>&1; then echo 'FAIL: busy original seat authority admitted'; exit 1; fi
grep -q 'Savage original seat authority busy' "$scratch/refused.log"
# Only this ephemeral database's explicitly named test session is cancelled.
"${psql[@]}" -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='midway-union-native-seat-lock'"
wait "$locker" || true
echo 'PASS: concurrent original seat authority refuses without waiting'
"${psql[@]}" -f "$migration"
"${psql[@]}" -f "$root/scripts/dev/fixtures/midway-union-cash-assert.sql"
proof=$(sed -n 's/^-- @live-proof: //p' "$migration")
[ -n "$proof" ]
"${psql[@]}" -Atc "SELECT ($proof)" | grep -qx t
echo 'PASS: Midway original create/implementation/ensure host authority, nine exact empty relocations, union custody, ACLs and atomic refusal'
