#!/usr/bin/env bash
# Proves the Share & Invite database layer against a DISPOSABLE Postgres
# (never production: CLAUDE.md production DDL rule 3).
#   PGURL=postgres://postgres@localhost:5432/postgres bash scripts/ci/club-invite-attribution/run.sh
# Creates a scratch database, loads a minimal stand-in for the production
# objects the migration touches, applies the migration, runs the scenarios,
# and fails on the first FAIL. 45 scenarios at the time of writing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
db="club_invite_$$"
psql "$PGURL" -q -c "CREATE DATABASE $db" >/dev/null
trap 'psql "$PGURL" -q -c "DROP DATABASE IF EXISTS $db" >/dev/null' EXIT
url="${PGURL%/*}/$db"
psql "$url" -q -v ON_ERROR_STOP=1 -f "$here/stub.sql" >/dev/null
psql "$url" -q -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261015181214_club_invite_links_and_attribution.sql" >/dev/null 2>&1
psql "$url" -q -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261015223818_club_invite_names_use_the_poker_alias.sql" >/dev/null 2>&1
psql "$url" -q -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261016004124_club_invite_stats_admit_automatic_members.sql" >/dev/null 2>&1
psql "$url" -q -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261016040136_club_invite_deep_sweep_hardening.sql" >/dev/null 2>&1
psql "$url" -q -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261016042212_club_invite_notify_actor_and_first_redemption.sql" >/dev/null 2>&1
out="$(psql "$url" -q -v ON_ERROR_STOP=1 -f "$here/scenarios.sql" 2>&1 || true)"
echo "$out" | grep -E 'PASS:|FAIL' || true
if echo "$out" | grep -qE 'FAIL|ERROR'; then echo "club invite attribution: FAILED"; exit 1; fi
echo "club invite attribution: $(echo "$out" | grep -c 'PASS:') scenarios passed"
