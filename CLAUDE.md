# Claude Instructions for Club Arena

## 🚨 MANDATORY: TypeScript Check Before EVERY Commit (NON-NEGOTIABLE)

**Before EVERY `git commit`, run `npx tsc --noEmit`. If it has ANY errors, DO NOT commit. Fix all errors first.**

```bash
# MUST run this before EVERY commit:
npx tsc --noEmit

# Only if exit code 0 → commit and push
git add -A && git commit -m "your message" && git push origin main
```

**Common mistakes that WILL break CI:**
- Importing a component that doesn't exist → create the file AND add to barrel `index.ts`
- Emitting bus events with fields not in `BusPayloadMap` → update `src/core/MasterBus.ts`
- Passing JSX props not in the component's Props interface → add to interface or remove prop

See `skills/mandatory-typecheck/SKILL.md` for the full protocol.

## MANDATORY FOR ALL AGENTS (AntiGravity, Claude, any AI agent)

**Club Arena has been PERMANENTLY migrated to smarter.poker.**

### Where to PUBLISH / SAVE / DEPLOY:

1. Build Club Arena: `npm run build` (Vite produces dist/)
2. Sync to World Hub: `bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub`
3. Push WORLD HUB (not Club Arena) to deploy: `cd ~/Documents/Smarter-Poker-World-Hub && bash scripts/git-safe-push.sh "your message"`
4. Verify on: `https://smarter.poker/hub/club-arena/`

### NEVER DO:

- NEVER run `vercel deploy` or `vercel --prod` in the Club Arena directory
- NEVER push to or deploy via `club-arena.vercel.app`
- NEVER push to or deploy via `club-engine.vercel.app`
- NEVER push to or deploy via `club.smarter.poker`
- NEVER add iframe code (`window.parent`, `postMessage`, `ClubArenaEmbed`)
- NEVER add `VITE_` prefixed secret keys (use server-side API routes instead)

### WHERE THINGS LIVE:

- Production URL: `https://smarter.poker/hub/club-arena/`
- Built files: `Smarter-Poker-World-Hub/public/hub/club-arena/` (618 files)
- Source code: `Smarter-Poker-Club-Arena/src/` (this repo)
- API routes: `Smarter-Poker-World-Hub/pages/api/club-arena/` (66 routes)
- Vercel project: `smarter-poker` (the ONLY deployment target)

## CRITICAL: Testing & Deployment Rules

**ALL live E2E testing MUST be done on `smarter.poker` — NEVER on `club-arena.vercel.app` directly.**

Club Arena lives 100% inside smarter.poker. All files (JS, CSS, HTML, images, cards,
videos, logos) are served from `smarter.poker/hub/club-arena/*` via the World Hub's
`public/` directory. ZERO requests go to external domains.

- Test URL: `https://smarter.poker/hub/club-arena/`
- NEVER navigate to or test on `club-arena.vercel.app` directly
- After code changes: rebuild with Vite, copy dist/ to World Hub's public/hub/club-arena/, push World Hub

## Architecture — How This App Is Served

Club Arena is a **Vite + React SPA** that lives inside the smarter.poker Next.js app:

1. **Production (user-facing)**: `smarter.poker/hub/club-arena/*` — served from World Hub's `public/` directory
2. **Build tool**: Vite builds the SPA into `dist/` — this output is copied to World Hub's `public/hub/club-arena/`
3. **SPA routing**: World Hub's `next.config.js` has `fallback` rewrites that serve `index.html` for unmatched routes
4. **Auth**: Same-origin Supabase session via shared `smarter-poker-auth` localStorage key

NO iframe. NO postMessage. NO proxy. NO external domain requests. Everything from smarter.poker.

### Deployment Pipeline

```
1. Make changes in Club Arena repo
2. Build: npm run build (Vite produces dist/)
3. Copy dist/ to World Hub: public/hub/club-arena/ (strip source maps)
4. Push World Hub to GitHub
5. Vercel auto-deploys smarter.poker with updated Club Arena files
```

### Vercel Project Details

- World Hub: `smarter-poker` (prj_FNUaJmcjRnwCSh1JzblIUYuOXDGK) — this is the ONLY deployment
- Club Arena code lives in: `public/hub/club-arena/` within the World Hub repo

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
- Club logos: 695K-948K (preset-*.png files)
- UI assets: 400K-600K (header-*.png, vip-card.png, poker-chip-logo.png)
- Frame images: 82K-102K (frames/frame-*.jpg)

Consider WebP conversion or lazy-loading for these assets.

## Known Bug Patterns (Fixed, Don't Reintroduce)

- Bad Beat Jackpot: Use `num.toLocaleString()`, NOT `padStart(9, '0')` for formatting
- VIP Badge: Always validate level against valid list before rendering — return null for invalid/empty/none
- Promotion types: Format raw DB enums (HIGH_HAND → "High Hand") before display
- Negative VIP points: Guard against currentPoints >= nextTierPoints edge case
- Bottom nav labels: Keep labels short (e.g., "Msgs" not "Messages") to prevent text truncation on small screens
