#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/acct-terms-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55487 -h ''" start >/dev/null
started=1
# Reuse the source-bound P&L fixture dependencies. Only these three duplicate
# bootstrap definitions already supplied by the agreement fixture are omitted;
# the sealed fixture source and the actual P&L functions are unchanged.
python3 - "$root" "$fixture/pnl-schema.sql" <<'PY'
from pathlib import Path
import sys
root, output = map(Path, sys.argv[1:])
source = (root / 'tests/fixtures/pnl-evidence/schema.sql').read_text()
for definition in (
    'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;\n',
    "CREATE FUNCTION u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT lpad(n::text,32,'0')::uuid$$;\n",
    'CREATE TABLE club_members(user_id uuid,club_id uuid);\n',
):
    if source.count(definition) != 1:
        raise SystemExit('Shared P&L fixture bootstrap changed: ' + definition)
    source = source.replace(definition, '')
output.write_text(source)
PY
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
  -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
  -f "$fixture/pnl-schema.sql" \
  -f "$root/supabase/accounting/weekly-v3/components/20260914150848_union_pnl_evidence_is_distinct_from_posted_chip_payments.sql" \
  -f "$root/tests/fixtures/accounting-agreement-history/eco-bootstrap.sql" \
  -f "$root/supabase/migrations/20260917230515_union_eco_terms_are_observed_at_their_original_write.sql" \
  -f "$root/tests/fixtures/accounting-agreement-history/regression.sql" \
  -f "$root/tests/fixtures/accounting-agreement-history/eco-regression.sql"
