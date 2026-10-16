#!/usr/bin/env bash
# Native RLS fail-before/pass-after witness; isolated SSD database only.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/private-rls.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55587 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -h "$scratch" -p 55587 -d postgres -v ON_ERROR_STOP=1)
# Exactly the predecessor policy block from the maintained migration.
sed -n '/^DROP POLICY IF EXISTS cash_games_read/,/^  );/p' "$root/supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql" | sed 's/auth.uid()/(SELECT auth.uid())/g' > "$scratch/baseline.sql"
"${psql[@]}" -v baseline="$scratch/baseline.sql" -f "$root/scripts/dev/fixtures/lightning-private-discovery.sql" >/dev/null
if "${psql[@]}" -c "SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000004',false); SELECT witness.assert_private_hidden();" >"$scratch/before.log" 2>&1; then
 echo 'FAIL: baseline did not reproduce pending membership exposure'; exit 1
fi
grep -q 'private game exposed to pending membership' "$scratch/before.log"
echo 'PASS: actual predecessor RLS exposes pending membership (expected before failure)'
"${psql[@]}" -f "$root/supabase/migrations/20261016124818_private_cash_discovery_requires_active_membership.sql" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.assert_all();' >/dev/null
"${psql[@]}" -c "SET ROLE service_role; DO \$\$ BEGIN IF (SELECT count(*) FROM public.cash_games)<>3 THEN RAISE EXCEPTION 'service visibility changed'; END IF; END \$\$;" >/dev/null
echo 'PASS: private owner/active/approved retained; pending/removed/banned/suspended/null/outsider denied; public and service visibility retained'
