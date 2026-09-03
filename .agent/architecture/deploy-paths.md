# Club Arena — Three-Tier Deploy Architecture

**This repo (`Smarter-Poker-Club-Arena`) is the canonical Club Arena codebase for two of the three tiers.** The third tier — Club Operations REST API — lives in `Smarter-Poker-World-Hub`.

The deprecated repo `Smarter-Poker/Club-Arena-Design` is archived (read-only). Do NOT push there. Its old `club-engine` Vercel project was deleted 2026-04-27.

---

## The three tiers (matches ClubGG / PokerBros / WPT Poker pattern)

```
┌──────────────────────────────────────────────────────────────────────┐
│  TIER 1 — REALTIME GAME ENGINE  (this repo, server/)                  │
│  Hetzner CPX11 ash-dc1 178.156.160.206  →  engine.smarter.poker      │
│  WebSocket: wss://engine.smarter.poker/ws/table/:tableId             │
│  HTTP:      POST /action, /timebank, /heartbeat, /addchips,          │
│             /leave, /sitout, /straddle, /rit, /insurance, /showhand, │
│             /discard, /post-bb, /admin/pause|/resume                  │
│             GET /health, /metrics, /ws-metrics, /state/:tableId       │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  TIER 2 — PLAYER FRONTEND  (this repo, src/)                          │
│  Vite build → Vercel project `club-arena`                             │
│  URLs: club.smarter.poker  +  smarter.poker/hub/club-arena/*          │
│  Features: lobby, table view, chat, hand history viewer, settings     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  TIER 3 — CLUB OPERATIONS REST API  (Smarter-Poker-World-Hub repo)    │
│  pages/api/club-arena/*  →  Vercel project `hub-vanguard`             │
│  URL: smarter.poker/api/club-arena/*  (67 endpoints as of 2026-04-27) │
│  Concerns:                                                            │
│   • Cashier: buyin, request-cashout, approve-cashout, cashout-history │
│   • Club management: create-club, delete-club, manage-table, manage-  │
│     shop, club-branding, lobby-ordering, table-templates              │
│   • Agent operations: agent-dashboard, agent-credit, manage-agent     │
│   • Union operations: union-application, union-wallet, manage-union   │
│   • Tournaments: tournaments, tournament-detail, tournament-cron      │
│   • Marketplace: marketplace-items, marketplace-purchase, sticker-    │
│     assets, generate-logo                                             │
│   • Settlement & rake: rakeback, record-rake, settle-period,          │
│     settlement-history, distribute-chips, transfer-chips, mint-chips, │
│     clawback-chips, promo-wallet, distribute-promo                    │
│   • Anti-cheat & audit: anti-cheat, audit-trail, player-notes         │
│   • Player ops: player-sessions, player-retention, player-chip-flow,  │
│     accept-tos, my-hands, waitlist                                    │
│   • Health: club-health, club-analytics, smart-recommendations        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Deploy paths — one per tier

### Tier 1: Game engine → Hetzner

| Source               | Where in repo                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Build root           | `server/` subdirectory                                                                                           |
| Hetzner server       | id `125093929`, `ash-dc1` (Ashburn VA), IP `178.156.160.206`, CPX11                                              |
| Hostname             | `engine.smarter.poker`                                                                                           |
| Process manager      | systemd + Docker container `club-arena-engine`                                                                   |
| Auto-deploy on push? | **No** — manual SSH-based deploy                                                                                 |
| How to deploy        | `bash server/deploy-hetzner.sh` (runs on Mac, SSHs to Hetzner)                                                   |
| Protocol             | WebSocket: `wss://engine.smarter.poker/ws/table/:tableId`, Bearer JWT auth                                       |
| Bible governance     | V8 Bible Law 1.16 — discrete named events only, no snapshot-diffs, no polling. Latency budget < 100ms broadcast. |

### Tier 2: Vite frontend → Club Arena's own origin (rewritten 2026-09-03)

| Source               | Where                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Build root           | repo root (`vite.config.ts`, `package.json`, `src/`)                                                       |
| Output               | `dist/`                                                                                                    |
| Published to         | `ca-static.smarter.poker` — Caddy on the Hetzner box `estate-ci-1`, `/srv/club-arena/`                     |
| Auto-deploy on push? | **YES, on merge to `main`** — `publish-club-arena.yml`, job `publish-to-origin`                            |
| How to deploy        | Push a branch. Nothing else. The pull request opens, autopilot merges it, the publisher publishes.         |
| Visible at           | `smarter.poker/hub/club-arena/*`, via ONE rewrite in the World Hub's `next.config.js`                      |
| Vercel project       | none. `vercel.json` still has `git.deploymentEnabled: false`; the bundle is not a Vercel deployment at all |

**The layout on the origin** (written by the publisher, never by hand):

```
/srv/club-arena/releases/<ca_sha>/   one directory per published bundle (10 kept)
/srv/club-arena/current -> releases/<ca_sha>    swapped atomically after rsync
/srv/club-arena/pool/{assets,fonts}/            ADDITIVE, pruned by age (30d)
```

The pool is the reason a player mid-hand does not 404: their tab may still
hold the previous `index.html` and ask for the previous hashed chunks. Never
`--delete` the pool, and never prune it by "not in the current bundle".

**Rollback** is one command on the box: point `current` at an older release.

**Until 2026-09-03 this tier went through the World Hub repo**: the publisher
committed `dist/` into `Smarter-Poker-World-Hub/public/hub/club-arena/`, which
meant a `chore(club-arena): sync build` commit in that repo and a 4-5 minute
rebuild of the entire World Hub for every Club Arena merge, about twenty times
a day. That path is gone — the directory, the sync scripts, the `check-ca-*`
gates and `sync-club-arena.sh` with it. If you find a document telling you to
run a sync script, that document is stale; this table is the current truth.

### Tier 3: Operations REST API → Vercel (different repo!)

| Source               | Where                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| Build root           | `Smarter-Poker/Smarter-Poker-World-Hub` (different repo!), `pages/api/club-arena/` |
| Vercel project       | `hub-vanguard` (production World Hub project)                                      |
| Auto-deploy on push? | **YES** — `git push` to World Hub `main` triggers Vercel auto-build                |
| How to deploy        | `cd ~/Documents/Smarter-Poker-World-Hub && git push origin main`                   |
| Visible at           | `smarter.poker/api/club-arena/*`                                                   |
| Auth                 | Server-side Supabase JWT validation per route                                      |
| Caveats              | Each route is its own Pages Router file; not a shared Hono router                  |

**The desync warning is smaller than it was (2026-09-03).** Tier 2 now deploys
itself on merge, and Tier 1 deploys itself on merge as well
(`auto-deploy-hetzner.yml`, hourly `:45` cutover). Only Tier 3 still rides the
World Hub's own Vercel build, which happens on a push to that repo's `main`. A
fix touching Tier 3 therefore needs a World Hub pull request; a fix touching
Tier 1 or 2 needs nothing but a merged branch in this repo.

---

## Decision tree: where do I push my fix?

```
┌─ Is the change about real-time gameplay (action validation, hand flow,
│  rake calc, RIT, insurance, disconnects, timer)?
│      → THIS repo, server/src/, then `bash server/deploy-hetzner.sh`
│
├─ Is the change about the player-facing UI (lobby, table view, chat UI,
│  card animations, sound, mobile layout)?
│      → THIS repo, src/, then `vercel --prod`
│
└─ Is the change about club admin / agent / cashier / BBJ / tournament-
   admin / anti-cheat / settlement / marketplace / unions?
       → Smarter-Poker/Smarter-Poker-World-Hub, pages/api/club-arena/<file>.js
       → git push to World Hub main → auto-deploys to smarter.poker/api/...
```

---

## Push gating (pre-push hooks in this repo)

1. No merge-conflict markers (lesson from World Hub commit `f490f61bf` April 2026 break).
2. No `vercel.json crons` block (Open Claw exclusive policy).
3. No client-side PIN-gate regression (server-side cookie + HMAC only).
4. No `supabase.auth.getUser()` outside `src/lib/auth/*`.

Bypass with `git push --no-verify` only in genuine emergencies.

---

## What's in scope for this repo vs other repos

**In scope (Tiers 1 + 2, edit here):**

- Bible V8 game logic (`server/src/`)
- All real-time action validators, state machines, engines
- Vite frontend code (`src/`)
- WebSocket protocol implementation (`server/src/transport/`)
- Player-facing UI components

**Out of scope (Tier 3 — edit `Smarter-Poker-World-Hub` instead):**

- Cashier flows (buyin, cashout, approve-cashout)
- Club admin (create-club, manage-table, club-branding, lobby-ordering)
- Agent operations (agent-dashboard, agent-credit, manage-agent)
- Union operations (union-application, union-wallet, manage-union)
- Tournament admin / scheduling
- Marketplace
- Settlement, rakeback, rake recording, chip distribution
- Anti-cheat reports + audit trails
- Player notes, retention analytics

**Out of scope (different products entirely):**

- World Hub UI (`Smarter-Poker/Smarter-Poker-World-Hub` `pages/`, `src/components/`)
- Commander Orb (`Smarter-Poker/smarter-poker-commander`)
- Cron handlers (`Smarter-Poker/smarter-poker-workers`)
- Open Claw scheduler config (`Smarter-Poker/Smarter-Poker-World-Hub` → `scripts/openclaw-cron-dispatcher.py`)

---

## Reference

- Master consolidation plan: `~/Documents/SMARTER-POKER-PLATFORM-CONSOLIDATION.md` on Dan's Mac.
- URL push-path matrix: `Smarter-Poker-World-Hub/.agent/architecture/url-map.md`.
- Agent Rulebook: `Smarter-Poker-World-Hub/.agent/architecture/ONE-SOURCE-OF-TRUTH.md`.
- Operations API inventory: `Smarter-Poker-World-Hub/.agent/architecture/club-arena-operations-api.md`.
