# Claude Instructions for Club Arena

## ACTIVE MIGRATION IN PROGRESS — READ BEFORE DOING ANYTHING

**There is an active server-authoritative migration happening. Before ANY code work, you MUST read these files:**

1. `MIGRATION-LAW.md` — 10 laws governing all migration work (ZERO exceptions)
2. `MASTER-MIGRATION-DOCUMENT.md` — Section 8 for current phase order
3. `STEP1-REMOVAL-CATALOG.md` — Exact removal targets with line numbers
4. `MIGRATION-CHANGELOG.md` — What's been done, where to resume
5. `skills/bible-v8/BIBLE-V8-REFERENCE.md` — The spec being built against

**Phase order (SACRED — Law 1):**
```
STEP 1: RIP OUT client-side engine code (establish ONE source of truth)
STEP 2: VERIFY CLEAN (grep confirms zero local authoritative state)
STEP 3: FIX SERVER BLOCKERS (card security, auto-fold, timer)
STEP 4: PORT CORE (PreciseActionTimer, ServerActionValidator, StateVerifier)
STEP 5: PORT SUPPORTING (TimeBankEngine, DisconnectEngine, PreActionEngine)
STEP 6: PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)
STEP 7: TOURNAMENT & EXTRAS (ChipRace, TableBalancer, OFC, Telemetry)
```

**You CANNOT skip ahead. You CANNOT build before cleanup. You CANNOT rubber-stamp.**
Every change: READ → DOCUMENT → CHANGE → VERIFY → LOG IN CHANGELOG.

---

## MANDATORY: FIX-FIRST PROCEDURE (NON-NEGOTIABLE)

**When auditing, verifying, or reviewing code against the Bible V8 spec:**

1. **FIND** an issue, bug, gap, or anything that needs to change
2. **FIX IT FULLY** — write the actual code fix, not just a note about it
3. **MOVE ON** to the next item
4. **REPEAT** until all items in the current phase are verified + fixed

**At the end of EVERY session:**
- All changes MUST be pushed to git (`git add → commit → push origin main`)
- Any database schema changes MUST be written to Supabase via SQL migration files
- Update `MIGRATION-CHANGELOG.md` with what was found AND fixed
- NEVER leave a session with unfixed identified issues — fix them or document them as blockers with exact reasons

**DO NOT:**
- Audit 10 items, list all the problems, then ask "what should I fix?" — FIX THEM AS YOU GO
- Mark something as "conditional pass" without fixing the condition
- Identify a bug and move to the next check without writing the fix

---

## MANDATORY: AntiGravity Handoff Protocol (WHILE VM DISK IS FULL)

**The Cowork VM disk is FULL. Agents CANNOT run bash commands (`git`, `npx tsc`, `npm`, etc.).**
**Until this is resolved, EVERY session MUST end with an AntiGravity handoff prompt.**

At the end of EVERY session, the agent MUST:

1. **Write all code fixes** using Read/Edit/Write tools (these still work on the mounted folder)
2. **Write a SQL migration file** if any database schema changes are needed (save to `supabase/migrations/`)
3. **Prepare a COMPLETE AntiGravity prompt** that contains EVERY command the agent could not run, including:
   - `npx tsc --noEmit` (TypeScript verification)
   - `git add -A && git status` (review staged files)
   - `git commit -m "message"` (commit with descriptive message)
   - `git push origin main` (push to remote)
   - `npm run build` (if frontend changes were made)
   - `bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub` (if frontend deploy needed)
   - Any Supabase SQL that needs to be run (`supabase db push` or manual SQL execution)
   - Any Railway deployment steps
4. **Present the prompt to the user** so they can paste it into AntiGravity or run it manually

**The handoff prompt format:**
```
## AntiGravity Handoff — [DATE] [SESSION SUMMARY]

### Step 1: TypeScript Check
cd ~/path/to/Smarter-Poker-Club-Arena
npx tsc --noEmit

### Step 2: Review Changes
git diff --stat
git status

### Step 3: Commit & Push
git add -A
git commit -m "descriptive message"
git push origin main

### Step 4: Supabase Migration (if needed)
[SQL commands or migration instructions]

### Step 5: Frontend Deploy (if needed)
npm run build
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
cd ~/Documents/Smarter-Poker-World-Hub
bash scripts/git-safe-push.sh "sync club-arena changes"

### What Changed:
[Bullet list of every file modified and why]
```

**NEVER end a session without this handoff. The user relies on it to complete the deployment pipeline.**

---

## MANDATORY: TypeScript Check Before EVERY Commit (NON-NEGOTIABLE)

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

## INFRASTRUCTURE — Where Everything Runs

**This project uses THREE services:**

| Service | Purpose | Location |
|---------|---------|----------|
| **Vercel** | Frontend hosting (smarter.poker) | `Smarter-Poker-World-Hub` repo → auto-deploys |
| **Railway** | Poker engine server (Node.js) | `server/` directory in this repo → deploys to Railway |
| **Supabase** | Database (PostgreSQL) + Auth + Realtime | `kuklfnapbkmacvwxktbh.supabase.co` |

### Railway (Poker Engine Server)
- Runs the server-authoritative game engine: `server/src/index.ts`
- Contains ALL game logic: HandController, ServerTableEngine, all engines
- HTTP endpoints: POST /action, POST /timebank, GET /actions, GET /health
- Uses `SUPABASE_SERVICE_ROLE_KEY` for database access (bypasses RLS)
- Deploy: push to Railway via Git or Railway CLI

### Supabase (Database + Auth + Realtime)
- PostgreSQL database: tables, table_seats, table_hole_cards, hand_history, etc.
- Auth: JWT-based authentication, shared with smarter.poker frontend
- Realtime: Broadcasts hand state to connected clients via WebSocket channels
- RLS: Row-Level Security protects hole cards (`table_hole_cards` — users can only read own cards)
- Migrations: `supabase/migrations/` directory
- **Any schema changes MUST be written as SQL migration files and applied to Supabase**

### Vercel (Frontend)
- Hosts the static SPA at `smarter.poker/hub/club-arena/`
- Files live in `Smarter-Poker-World-Hub/public/hub/club-arena/`
- Auto-deploys when World Hub repo is pushed

---

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
