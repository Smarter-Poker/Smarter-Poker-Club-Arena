# Club Arena -- Agent Instructions

ALL agents (Claude, AntiGravity, Cowork, any AI) MUST read this file at session start.
This is the single source of truth for **this repo**. Updated 2026-04-23.

**Platform-level plan** (CA + CE + Supabase + Hetzner + WH integration):
`~/Documents/Smarter-Poker-World-Hub/CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`

That document supersedes the old `POKERBROS_UPGRADE_PLAN.md`, `PHASE_3/4_*_PLAN.md`,
`MASTER_BLUEPRINT.md`, and every `ANTIGRAVITY-HANDOFF-*.md` (now in
`docs/_archive/handoffs/`). If any of those conflict with the platform plan, the
platform plan wins.

---

## 1. DEPLOYMENT PIPELINE

Club Arena is a Vite + React SPA that lives inside the smarter.poker Next.js app.
It deploys through the World Hub repo, NOT directly.

### 1.1 The Only Deploy Path

```bash
# 1. Build in Club Arena repo
cd ~/Documents/club-arena
npm run build

# 2. Sync to World Hub
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub

# 3. Push World Hub (this triggers Vercel deploy)
cd ~/Documents/Smarter-Poker-World-Hub
bash scripts/git-safe-push.sh "sync club-arena: <describe what changed>"
```

The push script handles everything: build gate, push, and post-deploy verification.
It exits 0 ONLY when production is verified serving your commit.

### 1.2 Vercel Project

- `hub-vanguard` (`prj_op66GkZyZcygXQKm76iyycfVFAQx`) -- THE REAL ONE. Aliased to `smarter.poker`.
- `smarter-poker` (`prj_FNUaJmcjRnwCSh1JzblIUYuOXDGK`) -- DEAD DUPLICATE. Disconnected. Do not touch.
- There are NO deploy hooks. The Vercel git integration auto-deploys on push to main.

### 1.3 Never Do

- Never run `vercel deploy` or `vercel --prod` in the Club Arena directory
- Never push to or test on `club-arena.vercel.app`
- Never call any deploy hook URL
- Never add iframe code (`window.parent`, `postMessage`, `ClubArenaEmbed`)
- Never add `VITE_` prefixed secret keys (use server-side API routes)
- Never edit `public/hub/club-arena/` in the World Hub directly (always rebuild from source)

### 1.4 Claiming Success

You may ONLY say a change is deployed after `git-safe-push.sh` exits 0.
Never say "should be live in a few minutes" or "deploy triggered."

---

## 2. INFRASTRUCTURE

| Service  | Purpose                          | Location                                        |
| -------- | -------------------------------- | ----------------------------------------------- |
| Vercel   | Frontend hosting (smarter.poker) | World Hub repo -> auto-deploys via hub-vanguard |
| Hetzner  | Poker engine server (Node.js)    | `server/` directory, deployed via SSH + PM2     |
| Supabase | Database + Auth + Realtime       | `kuklfnapbkmacvwxktbh.supabase.co`              |

### Hetzner VPS (Poker Engine Server)

- Runs server-authoritative game engine: `server/src/index.ts`
- ALL game logic lives here: HandController, ServerTableEngine, all engines
- HTTP endpoints: POST /action, POST /timebank, GET /actions, GET /health
- Uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS)

### Supabase

- PostgreSQL: tables, table_seats, table_hole_cards, hand_history
- Auth: JWT-based, shared with smarter.poker frontend
- Realtime: WebSocket broadcasts to connected clients
- RLS: Protects hole cards (users can only read own cards)
- Schema changes MUST be SQL migration files in `supabase/migrations/`

---

## 3. ACTIVE MIGRATION

There is a server-authoritative migration in progress. Before ANY code work, read:

1. `MIGRATION-LAW.md` -- 11 laws governing all migration work
2. `MASTER-MIGRATION-DOCUMENT.md` -- Section 8 for current phase order
3. `MIGRATION-CHANGELOG.md` -- What's done, where to resume

Phase order (sacred):

```
STEP 1: RIP OUT client-side engine code
STEP 2: VERIFY CLEAN (grep confirms zero local authoritative state)
STEP 3: FIX SERVER BLOCKERS (card security, auto-fold, timer)
STEP 4: PORT CORE (PreciseActionTimer, ServerActionValidator, StateVerifier)
STEP 5: PORT SUPPORTING (TimeBankEngine, DisconnectEngine, PreActionEngine)
STEP 6: PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)
STEP 7: TOURNAMENT & EXTRAS (ChipRace, TableBalancer, OFC, Telemetry)
STEP 8: TABLE SETTINGS & THEME CUSTOMIZATION (Bible V8 Chapter 11)
```

You CANNOT skip ahead. Every change: READ -> DOCUMENT -> CHANGE -> VERIFY -> LOG.

---

## 4. FIX-FIRST PROCEDURE

When auditing or reviewing code:

1. FIND an issue
2. FIX IT FULLY -- write the actual code, not just a note
3. MOVE ON to the next item
4. REPEAT until all items in the current phase are done

Do NOT audit 10 items and then ask "what should I fix?" -- fix them as you go.

---

## 5. CODE SAFETY RULES

1. Use `.maybeSingle()` never `.single()` for Supabase queries
2. Always handle null/undefined gracefully in display components
3. No emoji in source files (breaks SWC compiler)
4. VIP levels must be validated before rendering badges
5. Format numbers with `.toLocaleString()`, never `.padStart()`
6. TypeScript: run `npx tsc --noEmit` before committing. Fix ALL errors first.

---

## 6. FILE MAP

```
src/App.tsx              React Router (70+ routes)
src/pages/               Page components
src/components/          Shared components (club/, common/, vip/)
src/services/            API services (ClubService, TableService, TournamentService)
src/lib/supabase.ts      Supabase client
src/types/               TypeScript types
server/src/index.ts      Game engine server (Hetzner)
```

Production URL: `https://smarter.poker/hub/club-arena/`
Built files: `Smarter-Poker-World-Hub/public/hub/club-arena/`
API routes: `Smarter-Poker-World-Hub/pages/api/club-arena/`

---

## 7. ARCHITECTURE

Club Arena is a Vite + React SPA inside the smarter.poker Next.js app:

- Production: `smarter.poker/hub/club-arena/*` served from World Hub's `public/` directory
- Build: Vite produces `dist/`, copied to World Hub's `public/hub/club-arena/`
- Routing: SPA fallback rewrites unmatched routes to `index.html`
- Auth: Same-origin Supabase session via `smarter-poker-auth` localStorage key

NO iframe. NO postMessage. NO proxy. Everything from smarter.poker.

---

## 8. TECH STACK

Vite + React 19 + TypeScript, React Router v7, Supabase (PostgreSQL + Auth + Realtime),
CSS Modules + global CSS.

---

## 9. KNOWN BUG PATTERNS (fixed, don't reintroduce)

- Bad Beat Jackpot: Use `num.toLocaleString()`, NOT `padStart(9, '0')`
- VIP Badge: Validate level against valid list before rendering, return null for invalid
- Promotion types: Format raw DB enums (HIGH_HAND -> "High Hand") before display
- Negative VIP points: Guard against currentPoints >= nextTierPoints
- Bottom nav labels: Keep short ("Msgs" not "Messages") to prevent truncation

---

## 10. WORKING RULES (set by Dan, binding)

1. One step at a time. Finish and verify before the next.
2. Do it right, not fast. No band-aids.
3. However long it takes. Scope honestly.
4. Verify on real hardware. "It compiles" is not verification.
5. No emoji in code. Never call AI players "bots" (they are horses).
6. Mobile-first. 375px first, then scale up.
7. Never ask permission for obvious work. Just do it.
8. When corrected, change course immediately.
9. Write it down. Update MIGRATION-CHANGELOG.md at session end.
