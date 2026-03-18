#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Club Arena — Build & Verify Script
# ═══════════════════════════════════════════════════════════════════════════════
#  Builds Club Arena, runs safety checks, and verifies no iframe code leaked
#  back into the codebase. Run this before every push to main.
#
#  Usage: bash scripts/build-and-verify.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Club Arena — Build & Verify"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Safety checks (no iframe code) ──
echo "[1/4] Running iframe safety checks..."

IFRAME_COUNT=$(grep -rn "window\.parent" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | wc -l)
if [ "$IFRAME_COUNT" -gt 0 ]; then
  echo "  FAIL: Found $IFRAME_COUNT window.parent references!"
  grep -rn "window\.parent" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
  exit 1
fi
echo "  OK: Zero window.parent references"

POSTMSG_COUNT=$(grep -rn "postToParent\|parentOrigin\|waitForAuth\|earlyAuthBridge" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | grep "import" | wc -l)
if [ "$POSTMSG_COUNT" -gt 0 ]; then
  echo "  FAIL: Found $POSTMSG_COUNT imports of deleted iframe modules!"
  grep -rn "postToParent\|parentOrigin\|waitForAuth\|earlyAuthBridge" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep "import"
  exit 1
fi
echo "  OK: Zero imports of deleted iframe modules"

DOMAIN_COUNT=$(grep -rn "club-arena\.vercel\.app" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | wc -l)
if [ "$DOMAIN_COUNT" -gt 0 ]; then
  echo "  FAIL: Found $DOMAIN_COUNT hardcoded club-arena.vercel.app references!"
  grep -rn "club-arena\.vercel\.app" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
  exit 1
fi
echo "  OK: Zero hardcoded club-arena.vercel.app URLs"

echo ""

# ── Step 2: TypeScript check ──
echo "[2/4] TypeScript compilation check..."
npx tsc --noEmit
echo "  OK: Zero TypeScript errors"
echo ""

# ── Step 3: Vite build ──
echo "[3/4] Building with Vite..."
npm run build
echo ""

# ── Step 4: Verify built output ──
echo "[4/4] Verifying built output..."

BUILT_IFRAME=$(grep -c "window\.parent\|SMARTER_AUTH\|postToParent\|__EARLY_AUTH__" dist/index.html 2>/dev/null || true)
if [ "$BUILT_IFRAME" -gt 0 ]; then
  echo "  FAIL: Built index.html contains iframe code!"
  exit 1
fi
echo "  OK: Built index.html is clean"

BUILT_JS_IFRAME=$(grep -c "window\.parent\|SMARTER_AUTH\|postToParent\|__EARLY_AUTH__" dist/assets/index-*.js 2>/dev/null || true)
if [ "$BUILT_JS_IFRAME" -gt 0 ]; then
  echo "  FAIL: Built JS bundle contains iframe code!"
  exit 1
fi
echo "  OK: Built JS bundle is clean"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  BUILD SUCCESSFUL — All checks passed"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  Push to main to deploy:"
echo "    git push origin main"
echo ""
echo "  Changes will appear on smarter.poker automatically"
echo "  (World Hub proxies to club-arena.vercel.app at runtime)"
echo ""
