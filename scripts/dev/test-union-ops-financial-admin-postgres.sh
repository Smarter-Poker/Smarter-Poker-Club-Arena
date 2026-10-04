#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${UNION_OPS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"
binding="$repo/tests/fixtures/union-ops-financial-admin/source-binding.json"

python3 - "$repo" "$binding" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1])
binding = Path(sys.argv[2])
required = {
    "supabase/migrations/20261004153522_union_ops_reports_stay_inside_the_signed_in_budget.sql",
    "supabase/migrations/20261004173704_union_ops_risk_and_preview_stay_inside_the_request_budget.sql",
    "supabase/migrations/20261004202942_union_ops_risk_reads_bounded_production_facts.sql",
    "supabase/migrations/20261004212118_union_distribution_check_reads_daily_commission_facts.sql",
    "supabase/migrations/20261004221303_union_risk_uses_player_keyed_chip_flow_indexes.sql",
    "tests/fixtures/union-ops-financial-admin/bootstrap.sql",
    "tests/fixtures/union-ops-financial-admin/assertions.sql",
}
pins = json.loads(binding.read_text()).get("repository_files")
if not isinstance(pins, dict) or set(pins) != required:
    raise SystemExit("Union Ops source binding must pin exactly five migrations, bootstrap, and assertions.")
for relative, expected in sorted(pins.items()):
    actual = hashlib.sha256((repo / relative).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"Union Ops source binding drift: {relative}: {actual} != {expected}")
print("Union Ops Financial Admin source binding passed.")
PY

[[ -d "$scratch_parent" ]] || { echo "Union Ops PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }
[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || { echo 'PostgreSQL 17 tools are required.' >&2; exit 2; }
"$pgbin/postgres" --version | grep -q ' 17\.' || { echo 'PostgreSQL 17 is required.' >&2; exit 2; }

work="$(mktemp -d "$scratch_parent/union-ops-financial-admin.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((58000 + ($$ % 5000)))"
mkdir -p "$socket"
started=0
cleanup() {
  if [[ "$started" = 1 ]]; then "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; fi
  find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
started=1
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres)
"${psql[@]}" \
  -f "$repo/tests/fixtures/union-ops-financial-admin/bootstrap.sql" \
  -f "$repo/supabase/migrations/20261004153522_union_ops_reports_stay_inside_the_signed_in_budget.sql" \
  -f "$repo/supabase/migrations/20261004173704_union_ops_risk_and_preview_stay_inside_the_request_budget.sql" \
  -f "$repo/supabase/migrations/20261004202942_union_ops_risk_reads_bounded_production_facts.sql" \
  -f "$repo/supabase/migrations/20261004212118_union_distribution_check_reads_daily_commission_facts.sql" \
  -f "$repo/supabase/migrations/20261004221303_union_risk_uses_player_keyed_chip_flow_indexes.sql" \
  -f "$repo/tests/fixtures/union-ops-financial-admin/assertions.sql"

echo 'Union Ops Financial Admin PostgreSQL 17 fixture passed.'
