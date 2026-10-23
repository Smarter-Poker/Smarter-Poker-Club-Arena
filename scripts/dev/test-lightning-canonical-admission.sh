#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/lc.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/log" -o "-k $scratch -p 55621 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55621 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-group-preimage.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-preimages.sql"
"${psql[@]}" -f "$root/supabase/migrations/20261023230001_classic_and_lightning_five_ready_waits_three_seconds_for_six.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-admission-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-admission-preimages.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-transition-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-retirement-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-cashout-preimages.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-reversion-preimage.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-projection-preimages.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-transition-preimages.sql"
"${psql[@]}" -f "$root/supabase/migrations/20261023230807_canonical_lightning_pools_preserve_custody.sql"
# Exercise the same durable proof consumed by the installed-migration reader.
proof=$(sed -n 's/^-- @live-proof: //p' "$root/supabase/migrations/20261023230807_canonical_lightning_pools_preserve_custody.sql")
[ -n "$proof" ] || { echo 'FAIL: canonical migration has no live proof'; exit 1; }
"${psql[@]}" -Atc "SELECT ($proof)" | grep -qx t
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-admission-assert.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-canonical-transition-assert.sql"
"${psql[@]}" -f "$root/scripts/dev/lightning-retire-occupancies.sql" -f "$root/scripts/dev/fixtures/lightning-canonical-retirement-assert.sql"
echo 'PASS: exact-source canonical admission; actual zero-population conversion; active-hand and halt-observation barriers; committed replay; always-on population hold; physical six-player guard; explicit drain preserved; source VPIP/private authorization; unchanged occupied source custody'

