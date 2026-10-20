#!/usr/bin/env bash
# Finite native six-seat boundary qualification; no production connection.
# Owner ruling 2026-10-19: "make all lightning games 6 handed". Builds the
# installed image (template boundary + 20261016232120 + the thresholds wrapper),
# proves it is byte-for-byte the production catalog (md5), reproduces the
# defect (a nine-seat Action game can be enabled, converted and formed), then
# installs 20261020005222 and proves every door refuses it by name while six-seat
# Action and Madness keep working and ordinary games keep every ordinary state.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/lsix.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55591 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55591 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-template-boundary.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-template-predecessors.sql"
"${psql[@]}" -f "$root/supabase/migrations/20261016232120_lightning_only_action_and_madness_templates.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-six-seat-predecessors.sql"
# Nine-seat and other-size Action/Madness games beside the six-seat ones.
"${psql[@]}" <<'SQL'
INSERT INTO cash_games(id,club_id,template_name,ruleset_snapshot,handedness) VALUES
('00000000-0000-4000-a000-000000000019','11111111-1111-4111-a111-111111111111','action','{"template":"action"}',9),
('00000000-0000-4000-a000-000000000029','11111111-1111-4111-a111-111111111111','madness','{"template":"madness"}',9),
('00000000-0000-4000-a000-000000000028','11111111-1111-4111-a111-111111111111','madness','{"template":"madness"}',8),
('00000000-0000-4000-a000-000000000012','11111111-1111-4111-a111-111111111111','action','{"template":"action"}',2),
('00000000-0000-4000-a000-000000000039','11111111-1111-4111-a111-111111111111','classic','{"template":"classic"}',9);
SQL
# The native image is the installed production image, byte for byte.
"${psql[@]}" <<'SQL'
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_lightning_operator_control(uuid,text,text,jsonb)','813e24dd762cc05e40cd3f314f98b5dc'),
  ('public.fn_lightning_rollout_readiness(uuid)','eeec07e85e652927425c00dc6ccbb50a'),
  ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)','54e82f4fc1242910db9445ef9e726985'),
  ('public.fn_lightning_hand_template_guard()','a5ea48ba97c0d876c6eb11d524d52964'),
  ('public.fn_lightning_template_allowed(text,jsonb)','95bfa03b98abc72cca5eb76f16378156'),
  ('public.fn_cash_cluster_lightning_thresholds(uuid)','7d15c333256cd99733d275e7794962f4'),
  ('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)','6f1aa6bdebb5f5b33c0b2c50969aec2d')) x(sig,want)
 LOOP
  IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
   RAISE EXCEPTION 'FAIL native image is not the production image: % (%)',r.sig,md5(pg_get_functiondef(r.sig::regprocedure));
  END IF;
 END LOOP;
END $$;
SQL
echo 'PASS: native catalog equals the production images (7 md5s)'
"${psql[@]}" <<'SQL'
BEGIN;
SET ROLE authenticated;
UPDATE cash_games SET lightning_enabled=true,cluster_mode='lightning' WHERE handedness<>6 AND template_name IN ('action','madness');
INSERT INTO lightning_hand(cluster_id) VALUES('00000000-0000-4000-a000-000000000019');
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM lightning_hand) THEN RAISE EXCEPTION 'FAIL predecessor exposure not reproduced'; END IF; END $$;
ROLLBACK;
BEGIN;
SET ROLE authenticated;
DO $$ DECLARE r jsonb; BEGIN
 -- Whatever the rest of the enable path does in this boundary, the
 -- predecessor never refuses a nine-seat Action game for its size.
 BEGIN
  r:=fn_lightning_operator_control('00000000-0000-4000-a000-000000000019','enable_lightning','native qualification',jsonb_build_object('request_id',gen_random_uuid()));
 EXCEPTION WHEN OTHERS THEN r:=jsonb_build_object('raised',SQLERRM);
 END;
 IF r->>'code' IN ('LIGHTNING_TABLE_SIZE_NOT_ALLOWED','LIGHTNING_TEMPLATE_NOT_ALLOWED') OR coalesce(r->>'raised','') LIKE '%LIGHTNING_%' THEN RAISE EXCEPTION 'FAIL predecessor already refuses %',r; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(fn_lightning_rollout_readiness('00000000-0000-4000-a000-000000000019')->'reasons') x WHERE x->>'code' LIKE 'LIGHTNING_%_NOT_ALLOWED') THEN RAISE EXCEPTION 'FAIL predecessor readiness already blocks'; END IF;
END $$;
ROLLBACK;
SQL
echo 'PASS: before image admits nine-seat Action/Madness Lightning activation, formation and operator enable (expected defect)'
"${psql[@]}" -f "$root/supabase/migrations/20261020005222_lightning_only_on_six_seat_action_and_madness.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-six-seat-assertions.sql"
# The migration's own live proofs hold on the installed native image.
while IFS= read -r proof; do
 [ "$("${psql[@]}" -At -c "SELECT ($proof)")" = t ] || { echo "FAIL: live proof: $proof"; exit 1; }
done < <(sed -n 's/^-- @live-proof: //p' "$root/supabase/migrations/20261020005222_lightning_only_on_six_seat_action_and_madness.sql")
echo 'PASS: six-seat Action/Madness keep Lightning; every other size refused by name at the constraint, hand trigger, operator door, readiness, thresholds and formation; ordinary games keep every ordinary state; live proofs hold'
