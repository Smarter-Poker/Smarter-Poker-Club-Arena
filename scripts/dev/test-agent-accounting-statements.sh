#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/agent-stmt-test.XXXXXX")
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
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/agent-accounting-statements/bootstrap.sql" \
  -f "$root/tests/fixtures/agent-accounting-statements/baseline.sql" \
  -f "$root/supabase/migrations/20260914120403_agent_statements_scope_each_club_and_read_posted_evidence.sql" \
  -f "$root/tests/fixtures/agent-accounting-statements/regression.sql"
# AGENT COMMISSION LANDS IN AGENT WALLETS (2026-10-22): the weekly round 2 and
# round 3 owner rules behind every agent statement, on the exact live stages.
python3 -B "$root/scripts/ci/test-commission-agent-wallet-postgres.py" --pg-bin "$pgbin" \
  --scratch-root "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# Owner-confirmed prior sends are discharged in those same R2/R3 owners once.
python3 -B "$root/scripts/ci/test-existing-transfer-discharge-postgres.py" --pg-bin "$pgbin" \
  --scratch-root "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# A former standalone zero book verifies the paid foreign original R2 receipts.
python3 -B "$root/scripts/ci/test-zero-standalone-foreign-postgres.py" --pg-bin "$pgbin" \
  --scratch-root "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# Valid historical role promotion cannot strand the original commission cascade.
python3 -B "$root/scripts/ci/test-historical-agent-role-postgres.py" --pg-bin "$pgbin" \
  --scratch-root "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# Deleted-agent reserves reuse only unchanged original payer proofs per request.
python3 -B "$root/scripts/ci/test-deleted-reserve-reuse-postgres.py" --pg-bin "$pgbin" \
  --scratch-root "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
