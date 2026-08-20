# Club Arena -- Agent Instructions

ALL agents (Claude, AntiGravity, Cowork, any AI) MUST read this file at session start.
This is the single source of truth for **this repo**. Updated 2026-04-28.

**↗ READ FIRST:** `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md`
That document is the canonical "where does my fix go?" decision tree, the
duplicate-table reconciliation, and the four-tier topology lock. Every agent
must read it before pushing any code. If the architecture doc contradicts
this CLAUDE.md, the architecture doc wins (it's newer + repo-canonical).

**Platform-level plan** (CA + Supabase + Hetzner + WH integration):
`~/Documents/Smarter-Poker-World-Hub/CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`

That document supersedes the old `POKERBROS_UPGRADE_PLAN.md`, `PHASE_3/4_*_PLAN.md`,
`MASTER_BLUEPRINT.md`, and every `ANTIGRAVITY-HANDOFF-*.md` (now in
`docs/_archive/handoffs/`). If any of those conflict with the platform plan, the
platform plan wins.

---

## 1. DEPLOYMENT PIPELINE

Club Arena is a Vite + React SPA that lives inside the smarter.poker Next.js app.
It deploys through the World Hub repo, NOT directly.

### 1.1 The Only Deploy Path (Phase U5.4 — one script, one push)

```bash
cd ~/Documents/Smarter-Poker-World-Hub
bash scripts/sync-club-arena.sh "feat(ca): <describe what changed>"
```

That script builds CA with NODE_ENV=production, copies the new build to the Hub, and stages it for local preview.

**To actually deploy to production:**

1. Commit your changes in the `club-arena` repository.
2. `git push` to `main` in `club-arena`.
3. A GitHub Action (`build-for-world-hub.yml`) will automatically build and sync it to the World Hub repository, which triggers the Vercel deploy.

`SENTRY_AUTH_TOKEN/ORG/PROJECT` are read from `~/Documents/club-arena/.env` if
not already exported. Bulky static dirs (`cards/`, `images/`, `club-logos/`,
`videos/`) are preserved — they're not in a fresh build.

**Legacy names** still work but just forward to the canonical script:

- `WH scripts/build-club-arena.sh` → `sync-club-arena.sh`
- `CA scripts/sync-to-world-hub.sh` → `sync-club-arena.sh`

For post-deploy verification that production is serving your commit, follow up
with `bash scripts/git-safe-push.sh` in the WH repo — but `sync-club-arena.sh`
already exits non-zero on build/push failure.

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

---

## 11. AGENT NETWORK + DEPLOY PLAYBOOK (added 2026-07-23, binding; corrected same day after live use)

Cloud Cowork sessions have a locked-down sandbox. Learn the map ONCE and never
ask Dan for a manual handoff again:

### What works from the cloud sandbox

- Supabase MCP: full production DB access (migrations, SQL). USE IT.
- GitHub MCP via device bridge (`mcp__remote-devices__github__*`): full repo
  read/write with Dan's token. `push_files` works for files up to ~65KB each
  (HorseLogic.ts at 63KB pushed clean). Branch -> PR -> merge = ONE deploy.
- Device bridge: stage files FROM Dan's disk, commit files TO Dan's disk.
  `device_bash` runs in a NO-NETWORK Linux VM with the folders mounted.
  rm is forbidden — mv junk into a `_to_delete/` folder instead.

### What is BLOCKED from the cloud sandbox (do not waste time retrying)

- Direct git clone/push (proxy MITM: "repo not enabled for this session")
- `api.github.com` from cloud Bash — same repo gate. Only the device-bridge
  GitHub MCP has repo access (so GitHub Actions run status is NOT readable;
  verify deploys through the DB instead, see below).
- npm/pip/apt/cargo/go registries (403), raw curl to the engine, SSH clients
  (none installed, none installable)
- Terminal/IDE computer-use is click-only (no typing)

### Hard-won traps (cost real hours — memorize)

- STALE STAGING CACHE: re-staging a previously staged device path returns OK
  but the uploads mount silently serves the ORIGINAL session-start snapshot.
  Always copy changed files to a FRESH device path first, then stage that.
  Or read small files with `device_bash cat` instead of staging.
- GIT IS BROKEN INSIDE THE DEVICE VM: the mount cannot unlink files, so every
  index-locking git command (status/add/commit) strands a fresh
  `.git/index.lock` that then blocks git on the Mac host too. NEVER run git
  write commands via `device_bash`. If a stale lock exists, `mv` it into
  `_to_delete/` and leave all git to the host.
- HEALTH ENDPOINT IS CACHE-FROZEN: WebFetch of
  `https://engine.smarter.poker/health` is cached (CDN + 15-min fetch cache).
  Never use it to verify a deploy or an uptime reset.
- Husky pre-commit runs Prettier on the host: file content on main may differ
  cosmetically from what you authored. Adopt the formatted HEAD as your base
  before editing, or diffs will lie to you.

### Pushing code (in order of preference)

1. Files < ~65KB: GitHub MCP `push_files` to a branch, then
   `create_pull_request` + `merge_pull_request`. One merge = one deploy.
2. Large files (e.g. ServerTableEngine.ts, 227KB): CHUNK them. Write base64
   chunks to Dan's disk via device_commit_files, reassemble with `device_bash`
   (cat chunks | base64 -d > file). Commit/push must then happen on the Mac
   HOST (VM git is broken, see traps): the Antigravity CLI on the host
   (`agy run "cd ~/Documents/club-arena && git add -A && git commit -m msg && git push"`)
   — agy is NOT in the VM PATH; it must be invoked through an
   Antigravity-reachable surface, not device_bash.
3. Last resort: write an executable `deploy.command` to Dan's Desktop with the
   exact commands so the handoff is one double-click, never copy-paste.

### Deploying + verifying the engine

- Push to `main` touching `server/**` auto-deploys Hetzner via
  `.github/workflows/auto-deploy-hetzner.yml`. No SSH needed. Docs-only
  pushes (CLAUDE.md, MIGRATION-CHANGELOG.md) do NOT trigger a deploy.
- VERIFY VIA SUPABASE, never the health endpoint: per-minute hand counts in
  `hand_history` show a restart dip right after the workflow finishes, and
  boot-time effects (fleet table creation/reactivation in `tables`, new
  variant tables seating horses) prove the new code is executing. Do NOT
  claim deployed until a DB-visible behavioral change confirms it.
- After deploy, mirror the exact pushed content back to Dan's working tree
  with device_commit_files so his next host-side `git pull` is clean.
