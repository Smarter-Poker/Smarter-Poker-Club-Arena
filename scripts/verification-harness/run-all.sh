#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Verification Harness — Run All Available Checks
# ═══════════════════════════════════════════════════════════════════════════════
# Halts on first failure. Outputs a summary at the end.
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATABASE_URL="${DATABASE_URL:-}"
ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"

PASS=0
FAIL=0
SKIP=0

run_sql() {
  local script="$1"
  local label="$2"
  if [[ -z "${DATABASE_URL}" ]]; then
    echo "SKIP  ${label} (DATABASE_URL not set)"
    SKIP=$((SKIP+1))
    return
  fi
  echo "─── RUN  ${label} ───"
  if psql "${DATABASE_URL}" -f "${DIR}/${script}" 2>&1 | tee /tmp/verify-out.log | grep -q '^FAIL'; then
    echo "FAIL  ${label}"
    FAIL=$((FAIL+1))
  else
    echo "PASS  ${label}"
    PASS=$((PASS+1))
  fi
}

run_bash() {
  local script="$1"
  local label="$2"
  echo "─── RUN  ${label} ───"
  if bash "${DIR}/${script}"; then
    echo "PASS  ${label}"
    PASS=$((PASS+1))
  else
    echo "FAIL  ${label}"
    FAIL=$((FAIL+1))
  fi
}

# ─── PHASE F-2 ───
run_sql "01-rls-regression.sql" "F-2 #1 RLS regression"

# ─── PHASE D-2 ───
run_sql "02-equal-share-rake.sql" "D-2 #1 equal-share rake"

# ─── PHASE G-2 ───
run_bash "04-engine-telemetry-snapshot.sh" "G-2 #0 engine health"

# ─── SUMMARY ───
echo
echo "═══ VERIFICATION HARNESS RESULT ═══"
echo "PASS: ${PASS}"
echo "FAIL: ${FAIL}"
echo "SKIP: ${SKIP}"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
