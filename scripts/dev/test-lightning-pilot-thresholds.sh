#!/usr/bin/env bash
# Finite native qualification of the private pilot threshold change; no
# production connection. Builds the installed reader image (five functions,
# byte-for-byte production by md5) and the two pilot games verbatim, proves the
# defaults (18/12) and the bands they derive (12/18/36), proves the migration's
# guards refuse a drifted scope, installs 20261022052324 and proves ON 12 / OFF 8
# from the ruleset, every other key preserved, bands 8/12/24 and the live proofs.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
mig="$root/supabase/migrations/20261022052324_lightning_pilots_switch_at_six_seat_pool_math.sql"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/lthr.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55593 -c listen_addresses=''" start >/dev/null || { tail -5 "$scratch/postgres.log"; exit 1; }
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55593 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-pilot-threshold-predecessors.sql"
A=56d5d6f0-23e9-41b0-b407-852aa1026c2a
M=681eb9e8-e9fd-4026-8ec6-64075b911d33
"${psql[@]}" <<'SQL'
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_lightning_table_size_allowed(integer)','a88280fe6aec4d3dcc8f436d8fe7d3bb'),
  ('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)','6f1aa6bdebb5f5b33c0b2c50969aec2d'),
  ('public.fn_cash_cluster_lightning_thresholds(uuid)','23bf6043e45ef4f357f22aeb3672ad3c'),
  ('public.fn_lightning_config_number(jsonb,text,numeric,numeric,numeric,boolean)','6fecef3bc37605bd5d894c7ada876e7e'),
  ('public.fn_lightning_config(uuid)','6fd2d2b632d31779b73f42100a109bf6')) x(sig,want)
 LOOP
  IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
   RAISE EXCEPTION 'FAIL native image is not the production image: % (%)',r.sig,md5(pg_get_functiondef(r.sig::regprocedure));
  END IF;
 END LOOP;
END $$;
SQL
echo 'PASS: native reader catalog equals the production images (5 md5s)'
"${psql[@]}" <<'SQL'
DO $$ DECLARE g uuid; r jsonb; c jsonb; BEGIN
 FOREACH g IN ARRAY ARRAY['56d5d6f0-23e9-41b0-b407-852aa1026c2a','681eb9e8-e9fd-4026-8ec6-64075b911d33']::uuid[] LOOP
  r := fn_cash_cluster_lightning_thresholds(g); c := fn_lightning_config(g);
  IF NOT (r @> '{"on":18,"off":12,"source":"default"}') THEN RAISE EXCEPTION 'FAIL before defaults %',r; END IF;
  IF NOT (c @> '{"diversity_thin_min":12,"diversity_medium_min":18,"diversity_large_min":36}') THEN RAISE EXCEPTION 'FAIL before bands %',c; END IF;
 END LOOP;
 -- The reader itself: the chosen pair is accepted, a pair that breaks the
 -- hysteresis rule is refused back to the defaults.
 IF NOT (fn_cash_cluster_lightning_thresholds_probe('{"on_threshold":12,"off_threshold":8}',6) @> '{"on":12,"off":8,"source":"ruleset"}') THEN RAISE EXCEPTION 'FAIL probe 12/8'; END IF;
 IF NOT (fn_cash_cluster_lightning_thresholds_probe('{"on_threshold":8,"off_threshold":8}',6) @> '{"on":18,"off":12,"source":"default_after_invalid_config"}') THEN RAISE EXCEPTION 'FAIL probe hysteresis'; END IF;
END $$;
SQL
echo 'PASS: before image answers the 18/12 defaults and 12/18/36 bands (the measured off-peak gap)'
# Guards: each drifted scope refuses and changes nothing.
guard() {
 local setup=$1 want=$2 out
 out=$("${psql[@]}" 2>&1 <<SQL || true
BEGIN;
$setup
\i $mig
SQL
)
 grep -q "$want" <<<"$out" || { echo "FAIL guard did not refuse ($want): $out"; exit 1; }
}
guard "UPDATE cash_games SET handedness=9 WHERE id='$M';" 'is not the exact private six-seat pilot'
guard "UPDATE cash_games SET ruleset_snapshot=jsonb_set(ruleset_snapshot,'{options,is_private}','false') WHERE id='$A';" 'is not the exact private six-seat pilot'
guard "UPDATE cash_games SET ruleset_snapshot=jsonb_set(ruleset_snapshot,'{lightning,on_threshold}','20') WHERE id='$A';" 'are not the expected defaults'
guard "CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(p_cfg jsonb, p_handedness integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS \$f\$ SELECT '{}'::jsonb \$f\$;" 'threshold reader changed'
guard "INSERT INTO cash_games(id,club_id,template_name,handedness,ruleset_snapshot,lightning_enabled) VALUES (gen_random_uuid(),gen_random_uuid(),'action',6,'{\"options\":{\"is_private\":false}}',true);" 'non-private game has Lightning enabled'
"${psql[@]}" -At -c "SELECT count(*) FROM cash_games WHERE ruleset_snapshot->'lightning' ? 'on_threshold'" | grep -qx 0 || { echo 'FAIL a refused guard left a change'; exit 1; }
echo 'PASS: drifted size, privacy, prior threshold, changed reader and public Lightning each refuse with nothing changed'
"${psql[@]}" -At -c "SELECT id||'='||md5((ruleset_snapshot-'lightning')::text)||':'||md5(((ruleset_snapshot->'lightning')-'on_threshold'-'off_threshold')::text) FROM cash_games ORDER BY id" > "$scratch/before.txt"
"${psql[@]}" -f "$mig"
"${psql[@]}" -At -c "SELECT id||'='||md5((ruleset_snapshot-'lightning')::text)||':'||md5(((ruleset_snapshot->'lightning')-'on_threshold'-'off_threshold')::text) FROM cash_games ORDER BY id" > "$scratch/after.txt"
cmp -s "$scratch/before.txt" "$scratch/after.txt" || { echo 'FAIL a key other than the two thresholds changed'; exit 1; }
"${psql[@]}" <<'SQL'
DO $$ DECLARE g uuid; r jsonb; c jsonb; BEGIN
 FOREACH g IN ARRAY ARRAY['56d5d6f0-23e9-41b0-b407-852aa1026c2a','681eb9e8-e9fd-4026-8ec6-64075b911d33']::uuid[] LOOP
  r := fn_cash_cluster_lightning_thresholds(g); c := fn_lightning_config(g);
  IF NOT (r @> '{"on":12,"off":8,"source":"ruleset","rejected":[]}') THEN RAISE EXCEPTION 'FAIL after thresholds %',r; END IF;
  IF NOT (c @> '{"on_threshold":12,"off_threshold":8,"threshold_source":"ruleset","diversity_thin_min":8,"diversity_medium_min":12,"diversity_large_min":24,"invalid":[]}') THEN RAISE EXCEPTION 'FAIL after config %',c; END IF;
  -- The six-seat floor: two concurrent hands to turn on, one full hand plus
  -- turnover to stay on, hysteresis of at least four.
  IF (r->>'on')::int < 12 OR (r->>'off')::int < 8 OR (r->>'on')::int - (r->>'off')::int < 4 THEN RAISE EXCEPTION 'FAIL floor %',r; END IF;
 END LOOP;
END $$;
SQL
while IFS= read -r proof; do
 [ "$("${psql[@]}" -At -c "SELECT ($proof)")" = t ] || { echo "FAIL: live proof: $proof"; exit 1; }
done < <(sed -n 's/^-- @live-proof: //p' "$mig")
# Installed once; a replay refuses (the defaults guard) rather than rewriting.
out=$("${psql[@]}" -f "$mig" 2>&1 || true)
grep -q 'are not the expected defaults' <<<"$out" || { echo "FAIL replay was not refused: $out"; exit 1; }
echo 'PASS: installed ON 12 / OFF 8 from the ruleset, bands 8/12/24, every other key preserved, live proofs true, replay refused'
