#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# STEP 3 VERIFICATION + COMMIT SCRIPT
# Run after all Step 3 edits are complete. Also commits Step 2 changelog.
# ═══════════════════════════════════════════════════════════════════════════
set -e

cd "$(dirname "$0")/.." || exit 1

echo "═══════════════════════════════════════════════════════════"
echo " STEP 3: Verify + Commit"
echo "═══════════════════════════════════════════════════════════"

# ── Phase 0: Commit Step 2 changelog if needed ──
if git diff --name-only HEAD | grep -q "MIGRATION-CHANGELOG.md"; then
  echo ""
  echo "▸ Phase 0: Committing Step 2 changelog update..."
  git add MIGRATION-CHANGELOG.md
  git commit -m "$(cat <<'EOF'
Step 2: VERIFY CLEAN gate passed — zero client-side engine code in UI

Comprehensive grep audit of entire src/ directory confirms:
- handControllerRef: 0 matches in UI (only in server engine, expected)
- broadcastLocalHandState: 0 non-comment matches in UI
- .performAction(: 0 matches in UI
- Engine imports: only timeBankEngine (Step 5) + type-only imports (safe)
- Zero "client is authoritative" claims remain

Gate result: PASS — ready for Step 3.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
  echo "  ✓ Step 2 changelog committed"
fi

# ── Phase 1: Grep Verification (card security) ──
echo ""
echo "▸ Phase 1: Grep verification for card security..."
FAIL=0

# Verify server scrubs cards (should find showdown-only check)
SCRUB_CHECK=$(grep -c "state.stage === 'showdown'" server/src/engine/ServerTableEngine.ts 2>/dev/null || echo "0")
if [ "$SCRUB_CHECK" -eq 0 ]; then
  echo "  ✗ Card scrubbing not found in broadcastCurrentState"
  FAIL=1
else
  echo "  ✓ Card scrubbing: found showdown-only check"
fi

# Verify CARDS_DEALT handler exists
CARDS_DEALT=$(grep -c "case 'CARDS_DEALT'" server/src/engine/ServerTableEngine.ts 2>/dev/null || echo "0")
if [ "$CARDS_DEALT" -eq 0 ]; then
  echo "  ✗ CARDS_DEALT handler not found"
  FAIL=1
else
  echo "  ✓ CARDS_DEALT handler: present"
fi

# Verify auto-fold removed (should NOT find "auto-folded" in the action handler)
AUTO_FOLD=$(grep -c "auto-folded" server/src/engine/ServerTableEngine.ts 2>/dev/null || echo "0")
if [ "$AUTO_FOLD" -gt 0 ]; then
  echo "  ✗ Auto-fold still present in handlePlayerAction ($AUTO_FOLD matches)"
  FAIL=1
else
  echo "  ✓ Auto-fold: removed from handlePlayerAction"
fi

# Verify auto-check logic exists
AUTO_CHECK=$(grep -c "Auto-checking" server/src/engine/ServerTableEngine.ts 2>/dev/null || echo "0")
if [ "$AUTO_CHECK" -eq 0 ]; then
  echo "  ✗ Auto-check logic not found in timer handler"
  FAIL=1
else
  echo "  ✓ Auto-check: timer handler has check-before-fold logic"
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "✗ GREP VERIFICATION FAILED — fix issues above before committing"
  exit 1
fi
echo ""
echo "✓ All grep checks passed"

# ── Phase 2: TypeScript Check (client) ──
echo ""
echo "▸ Phase 2: TypeScript compilation check (client)..."
TSC_OUTPUT=$(npx tsc --noEmit 2>&1) || true

if echo "$TSC_OUTPUT" | grep -q "error TS"; then
  ERROR_COUNT=$(echo "$TSC_OUTPUT" | grep -c "error TS" || echo "0")
  echo "  ✗ TypeScript found $ERROR_COUNT error(s):"
  echo "$TSC_OUTPUT" | grep "error TS" | head -20
  echo ""
  echo "Fix these errors before committing."
  echo "Full output saved to: /tmp/tsc-step3-errors.txt"
  echo "$TSC_OUTPUT" > /tmp/tsc-step3-errors.txt
  exit 1
fi
echo "  ✓ TypeScript: zero errors"

# ── Phase 3: TypeScript Check (server) ──
echo ""
echo "▸ Phase 3: TypeScript compilation check (server)..."
pushd server > /dev/null
SERVER_TSC_OUTPUT=$(npx tsc --noEmit 2>&1) || true
popd > /dev/null

if echo "$SERVER_TSC_OUTPUT" | grep -q "error TS"; then
  ERROR_COUNT=$(echo "$SERVER_TSC_OUTPUT" | grep -c "error TS" || echo "0")
  echo "  ✗ Server TypeScript found $ERROR_COUNT error(s):"
  echo "$SERVER_TSC_OUTPUT" | grep "error TS" | head -20
  echo ""
  echo "Fix these errors before committing."
  echo "Full output saved to: /tmp/tsc-step3-server-errors.txt"
  echo "$SERVER_TSC_OUTPUT" > /tmp/tsc-step3-server-errors.txt
  exit 1
fi
echo "  ✓ Server TypeScript: zero errors"

# ── Phase 4: Commit ──
echo ""
echo "▸ Phase 4: Git commit..."
git add server/src/engine/ServerTableEngine.ts src/pages/TablePage.tsx MIGRATION-CHANGELOG.md scripts/step3-verify-commit.sh scripts/commit-step2.sh
git status --short

git commit -m "$(cat <<'EOF'
Step 3: Fix 3 server blockers — card security, auto-fold, timer

BLOCKER #1 — Card Security:
- Scrub all hole cards from Supabase Realtime broadcast (only reveal at
  showdown for non-folded players)
- Add CARDS_DEALT handler that writes cards to RLS-protected
  table_hole_cards table via insert_hole_cards RPC
- Fix client card handling: use sp.cards.length check instead of truthy
  check (empty arrays are truthy in JS)
- Show opponent cards only at showdown when not folded

BLOCKER #2 — Auto-Fold on Error:
- Remove auto-fold in catch block of handlePlayerAction()
- Return error to client instead — player keeps their hand

BLOCKER #3 — Timer Auto-Check:
- Check canCheck (amountToCall === 0) before deciding timeout action
- Auto-check when no bet outstanding (standard poker behavior)
- Auto-fold only when there's a bet to call

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

# ── Phase 5: Push ──
echo ""
echo "▸ Phase 5: Push to origin..."
git push origin main

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " ✓ STEP 3 COMPLETE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next: Step 4 — PORT CORE (PreciseActionTimer, ServerActionValidator, StateVerifier)"
