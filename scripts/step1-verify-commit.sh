#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# STEP 1 VERIFICATION + COMMIT SCRIPT
# Run this ONE TIME after all Step 1 edits are complete
# ═══════════════════════════════════════════════════════════════════════════
set -e

echo "═══════════════════════════════════════════════════════════"
echo " STEP 1: Verify + Commit"
echo "═══════════════════════════════════════════════════════════"

# ── Phase 1: Grep Verification ──
echo ""
echo "▸ Phase 1: Grep verification..."
FAIL=0

check_zero() {
  local label="$1"
  local count="$2"
  if [ "$count" -gt 0 ]; then
    echo "  ✗ $label: $count matches (SHOULD BE 0)"
    FAIL=1
  else
    echo "  ✓ $label: 0 matches"
  fi
}

HC_COUNT=$(grep -c "handControllerRef" src/pages/TablePage.tsx 2>/dev/null || echo "0")
BL_COUNT=$(grep -v "//" src/pages/TablePage.tsx | grep -c "broadcastLocalHandState" 2>/dev/null || echo "0")
PA_COUNT=$(grep -c "\.performAction(" src/pages/TablePage.tsx 2>/dev/null || echo "0")
MC_COUNT=$(grep -v "//" src/pages/TablePage.tsx | grep -c "monteCarloEquity" 2>/dev/null || echo "0")
SA_COUNT=$(grep -v "//" src/pages/TablePage.tsx | grep -c "serverActionValidator" 2>/dev/null || echo "0")

check_zero "handControllerRef" "$HC_COUNT"
check_zero "broadcastLocalHandState (non-comment)" "$BL_COUNT"
check_zero ".performAction(" "$PA_COUNT"
check_zero "monteCarloEquity (non-comment)" "$MC_COUNT"
check_zero "serverActionValidator (non-comment)" "$SA_COUNT"

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "✗ GREP VERIFICATION FAILED — fix issues above before committing"
  exit 1
fi
echo ""
echo "✓ All grep checks passed"

# ── Phase 2: TypeScript Check ──
echo ""
echo "▸ Phase 2: TypeScript compilation check..."
TSC_OUTPUT=$(npx tsc --noEmit 2>&1) || true
TSC_EXIT=$?

if echo "$TSC_OUTPUT" | grep -q "error TS"; then
  ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c "error TS" || echo "0")
  echo "  ✗ TypeScript found $ERROR_COUNT error(s):"
  echo "$TSC_OUTPUT" | grep "error TS" | head -20
  echo ""
  echo "Fix these errors before committing."
  echo "Full output saved to: /tmp/tsc-step1-errors.txt"
  echo "$TSC_OUTPUT" > /tmp/tsc-step1-errors.txt
  exit 1
fi
echo "  ✓ TypeScript: zero errors"

# ── Phase 3: Commit ──
echo ""
echo "▸ Phase 3: Git commit..."
git add src/pages/TablePage.tsx MIGRATION-CHANGELOG.md STEP1-REMOVAL-CATALOG.md
git status --short

git commit -m "$(cat <<'EOF'
Step 1: Remove client-side HandController engine from TablePage

Rip out ~780 lines of client-side game engine code, establishing
the server as the single source of truth for all game state.

Removed: HandController creation/init block, all 51 handControllerRef
references, broadcastLocalHandState (14 callsites), local performAction
calls in all action handlers, serverActionValidator, monteCarloEquity.

Action handlers now route through submitAction() to server only.
HC state reads replaced with Zustand tableState throughout.

timeBankEngine kept (deferred to Step 5 per migration phase order).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

# ── Phase 4: Push ──
echo ""
echo "▸ Phase 4: Push to origin..."
bash scripts/git-safe-push.sh "Step 1: Remove client-side HandController engine"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " ✓ STEP 1 COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next: Step 2 — VERIFY CLEAN (grep confirms zero local authoritative state)"
