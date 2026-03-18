# Claude Instructions for Club Arena

## CRITICAL: Testing & Deployment Rules

**ALL live E2E testing MUST be done on `smarter.poker` — NEVER on `club-arena.vercel.app` directly.**

Club Arena is served on smarter.poker via transparent same-origin proxy rewrites.
The standalone URL (`club-arena.vercel.app`) is the build target only — users access
the app through `smarter.poker/hub/club-arena/*`.

- Test URL: `https://smarter.poker/hub/club-arena/`
- NEVER navigate to or test on `club-arena.vercel.app` directly
- All updates publish automatically to smarter.poker via Vercel proxy (no separate deploy needed)

## Architecture — How This App Is Served

Club Arena is a **Vite + React SPA** served on `smarter.poker` via proxy rewrites:

1. **Production (user-facing)**: `smarter.poker/hub/club-arena/*` — proxied from club-arena.vercel.app
2. **Build target**: `club-arena.vercel.app` — Vercel deployment URL (proxied, NOT accessed directly)

The World Hub's `next.config.js` has `afterFiles` rewrites that transparently proxy
all `/hub/club-arena/*` requests to `club-arena.vercel.app`. The browser sees `smarter.poker`
URLs, so localStorage and Supabase auth are shared (same origin). NO iframe, NO postMessage.

### Deployment Pipeline

```
Push to GitHub (Smarter-Poker/Smarter-Poker-Club-Arena)
  → Vercel auto-deploys to club-arena.vercel.app
  → Changes appear on smarter.poker immediately (proxy serves at runtime)
  → NO World Hub deploy needed for Club Arena code changes
```

### Vercel Project Details

- Project: `club-arena` (prj_oaCq8RYhExLRUYizLG93li0uX468)
- Team: team_SVD8r7AOPH065G3usBxVvrBc
- Domains: club-arena.vercel.app, club-arena-smarter-poker.vercel.app

## Tech Stack

- Vite + React 18 + TypeScript
- React Router v6
- Supabase (PostgreSQL + Auth + Realtime)
- CSS Modules + global CSS

## Key Directories

```
src/App.tsx              — React Router (70+ routes)
src/pages/               — Page components
src/components/          — Shared components (club/, common/, vip/)
src/services/            — API services (ClubService, TableService, TournamentService)
src/lib/supabase.ts      — Supabase client
src/types/               — TypeScript types
```

## Auth

- Same-origin auth via shared Supabase localStorage key (`smarter-poker-auth`)
- User logs into smarter.poker, Club Arena reads the same session automatically
- NO iframe, NO postMessage, NO `window.parent` checks — all eliminated March 2026
- Standard `supabase.auth.getSession()` and `supabase.auth.getUser()` everywhere

## Code Safety Rules

1. Use `.maybeSingle()` instead of `.single()` for Supabase queries
2. Always handle null/undefined gracefully in display components
3. VIP levels must be validated — only render badges for valid levels (bronze/silver/gold/platinum/diamond)
4. Format numbers with `.toLocaleString()` — never zero-pad with `.padStart()`

## Performance Optimizations

- **Recharts pages**: Already lazy-loaded via React.lazy() in App.tsx (PlayerStatsPage, RakebackPage, etc.)
- **Offline queue**: Max size capped at 50 items (see `src/utils/offlineQueue.ts`)
- **Bundle analysis**: Run `npm run analyze` to visualize bundle size and identify large chunks

## Large Images (>100KB)

The following images are in `/public` and should be candidates for optimization:

- Card backs: 3.1-3.7MB (backs/black.jpeg, white.jpeg, blue.jpeg, red.jpeg)
- Club logos: 695K-948K (preset-\*.png files)
- UI assets: 400K-600K (header-\*.png, vip-card.png, poker-chip-logo.png)
- Frame images: 82K-102K (frames/frame-\*.jpg)

Consider WebP conversion or lazy-loading for these assets.

## Known Bug Patterns (Fixed, Don't Reintroduce)

- Bad Beat Jackpot: Use `num.toLocaleString()`, NOT `padStart(9, '0')` for formatting
- VIP Badge: Always validate level against valid list before rendering — return null for invalid/empty/none
- Promotion types: Format raw DB enums (HIGH_HAND → "High Hand") before display
- Negative VIP points: Guard against currentPoints >= nextTierPoints edge case
- Bottom nav labels: Keep labels short (e.g., "Msgs" not "Messages") to prevent text truncation on small screens
