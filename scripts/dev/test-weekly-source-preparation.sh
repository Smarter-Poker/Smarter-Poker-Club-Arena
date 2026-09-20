#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/wk-source.XXXXXX")
started=0
cleanup(){ if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55493 -h ''" start >/dev/null
started=1
python3 - "$root" "$fixture/preparation.sql" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);s=(root/'supabase/accounting/weekly-v3/components/20260914131539_cash_commissions_account_for_every_contributor_once.sql').read_text()
a=s.index('-- One scope resolver admits');b=s.index('CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting',a)
Path(sys.argv[2]).write_text(s[a:b])
PY
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -d postgres \
 -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/period-writer-bootstrap.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132216_cash_rakeback_periods_require_one_certified_week.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/preparation-bootstrap.sql" \
 -f "$fixture/preparation.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/preparation-seed.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/preparation-regression.sql"
