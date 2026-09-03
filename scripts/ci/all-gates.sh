#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  all-gates.sh — run every CI gate that can run locally, in CI's own order
# ═══════════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (Dan 2026-08-25). `npx tsc --noEmit` and `npx vitest run` both
# passed on a change that CI then rejected, because ci.yml runs eight more
# checks that nothing local invoked. The one that caught it, check-css-modules,
# fails on a styles.* key with no matching class - which ships
# className={undefined}, so the element renders unstyled and NOTHING warns at
# runtime. That is exactly the class of fault a local gate should catch.
#
# Not covered here: the Playwright e2e projects (they need a browser download)
# and the migrations check (it needs live Supabase credentials).
#
# Usage:  bash scripts/ci/all-gates.sh [--fast]
#         --fast  skips the production build (and therefore bundle-size)
set -uo pipefail
cd "$(dirname "$0")/../.."

FAST=false
[ "${1:-}" = "--fast" ] && FAST=true

fails=0
step() {
  printf '  %-42s ' "$1"
  shift
  if out=$("$@" 2>&1); then
    echo 'OK'
  else
    echo 'FAILED'
    echo "$out" | tail -20 | sed 's/^/      /'
    fails=$((fails + 1))
  fi
}

echo '── Type safety ─────────────────────────────────────────────'
step 'tsc --noEmit' npx tsc --noEmit

echo '── House rules ─────────────────────────────────────────────'
for g in check-css-modules check-title-case check-nav-title-case check-ui-text check-no-emoji check-esm-require \
         check-allin-pointer-events check-monitoring-drift check-horses-are-players \
         check-rake-schedule-parity check-seat-law-parity check-discarded-read-then-write \
         check-rake-bbj-collection-law check-new-migration-version-collisions; do
  step "$g" node "scripts/ci/$g.mjs"
done

echo '── Tests ───────────────────────────────────────────────────'
step 'vitest run tests/' npx vitest run tests/ --reporter=dot

if [ "$FAST" = false ]; then
  echo '── Build ───────────────────────────────────────────────────'
  step 'vite build' npx vite build
  step 'bundle-size' node scripts/ci/bundle-size.mjs
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "all-gates: OK - every local gate passed."
else
  echo "all-gates: $fails gate(s) FAILED. Do not push."
  exit 1
fi
