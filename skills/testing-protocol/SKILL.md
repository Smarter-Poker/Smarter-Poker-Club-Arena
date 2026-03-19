---
name: testing-protocol
description: 'MANDATORY testing protocol. All verification and testing MUST occur on smarter.poker directly — NEVER on localhost or Vercel preview URLs. Use localhost only for build verification during development. Trigger on: every test, every verification, every QA, every audit, every browser check.'
---

# Testing Protocol — smarter.poker Only

## RULE (NON-NEGOTIABLE)

- **Building / Development** → Use localhost dev server (`npm run dev`)
- **Testing / Verification** → Use `https://smarter.poker` directly — NEVER localhost, NEVER `*.vercel.app`

## WHY

- `smarter.poker` is the production environment with real Supabase data, real auth, real SSO framing
- Localhost lacks the SSO iframe context, real user sessions, and production RLS policies
- Vercel preview URLs (`club-arena-*.vercel.app`) bypass the Hub framing and have different auth behavior
- Testing on anything other than production gives false confidence

## DEVELOPMENT PHASE (localhost OK)

During active development, you MAY use localhost for:

- ✅ Build verification (`npm run build`)
- ✅ TypeScript error checking
- ✅ Checking that components render without crashes
- ✅ Hot-reload iteration while writing code

## TESTING PHASE (smarter.poker ONLY)

When verifying that a feature works correctly, you MUST:

1. **Push the code to GitHub** (see `auto-push` skill)
2. **Wait for Vercel deployment** to complete
3. **Test on `https://smarter.poker/hub/club-arena/`** directly

### What to test on smarter.poker:

- ✅ UI rendering and layout
- ✅ Data fetching and display
- ✅ Real-time updates (bus events, Supabase channels)
- ✅ Navigation and routing
- ✅ Auth-gated features
- ✅ Mobile responsiveness
- ✅ Cross-page state sync

### URLs to use:

- **Lobby**: `https://smarter.poker/hub/club-arena/`
- **Club pages**: `https://smarter.poker/hub/club-arena/clubs/{id}`
- **Tables**: `https://smarter.poker/hub/club-arena/table/{id}`
- **Horse Admin**: `https://smarter.poker/horses`

## PROHIBITED

- ❌ NEVER test on `http://localhost:*`
- ❌ NEVER test on `https://club-arena*.vercel.app`
- ❌ NEVER report "verified working" based on localhost checks alone
- ❌ NEVER screenshot localhost as proof of verification

## BROWSER TESTING

When using browser tools to verify:

1. Navigate to `https://smarter.poker/hub/club-arena/` (or the relevant sub-page)
2. Interact with the actual production deployment
3. Screenshot the production URL as proof
4. Report findings based on the live production environment
