#!/usr/bin/env bash
# Finite native template-boundary qualification; no production connection.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ltpl.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55589 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55589 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-template-boundary.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-template-predecessors.sql"
"${psql[@]}" <<'SQL'
BEGIN;
SET ROLE authenticated;
UPDATE cash_games SET lightning_enabled=true,cluster_mode='lightning' WHERE ruleset_snapshot->>'template'='classic';
INSERT INTO lightning_hand(cluster_id) VALUES('00000000-0000-4000-a000-000000000001');
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM lightning_hand) THEN RAISE EXCEPTION 'FAIL predecessor exposure not reproduced'; END IF; END $$;
ROLLBACK;
SQL
echo 'PASS: before image admits Classic Lightning activation/formation (expected defect)'
"${psql[@]}" -f "$root/supabase/migrations/20261016232120_lightning_only_action_and_madness_templates.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-template-assertions.sql"
echo 'PASS: Action/Madness native positives; Classic/unknown/null refused; ordinary cash/replay retained; legacy formation refused'


# Owner ruling 2026-10-19: every Lightning game is six-seat as well. Its own
# disposable cluster, chained here so the required native step runs it.
bash "$root/scripts/dev/test-lightning-six-seat-boundary.sh"
