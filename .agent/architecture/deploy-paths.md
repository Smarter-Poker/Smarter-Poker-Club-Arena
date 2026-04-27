# Club Arena — Deploy Paths

**This repo (`Smarter-Poker-Club-Arena`) is the canonical Club Arena codebase.**

The deprecated repo `Smarter-Poker/Club-Arena-Design` is archived (read-only). Do NOT push there. Its old `club-engine` Vercel project was deleted 2026-04-27.

## Two deploy paths from this one repo

### 1. Vite frontend → Vercel (`club-arena` project)

| Source | Where in repo |
|---|---|
| Build root | repo root (`vite.config.ts`, `package.json`, `src/`) |
| Output | `dist/` (per `vercel.json`) |
| Vercel project | `club-arena` (id `prj_oaCq8RYhExLRUYizLG93li0uX468`) |
| Auto-deploy on push? | **No** — `vercel.json` has `git.deploymentEnabled: false` |
| How to deploy | Manual: trigger via Vercel dashboard or `vercel --prod` |
| Visible at | `smarter.poker/hub/club-arena/*` (served as static assets via World Hub) and `club.smarter.poker/` (redirect) |

### 2. Game server → Hetzner CPX11 (`engine.smarter.poker`)

| Source | Where in repo |
|---|---|
| Build root | `server/` subdirectory |
| Hetzner server | id `125093929`, `ash-dc1` (Ashburn VA), IP `178.156.160.206`, CPX11 |
| Hostname | `engine.smarter.poker` |
| Process manager | systemd (per Hetzner ops docs in `.memory/`) |
| Auto-deploy on push? | **No** — manual SSH-based deploy |
| How to deploy | `bash server/deploy-hetzner.sh` (runs locally on Mac, SSH's to Hetzner) |
| Protocol | WebSocket: `wss://engine.smarter.poker/ws/table/:tableId`, Bearer JWT auth |
| Bible governance | V8 Bible Law 1.16 — discrete named events only, no snapshot-diffs, no polling. Latency budget < 100ms broadcast. |

**These two deploys can desync.** A `git push` to `main` only signals that source is updated; nobody auto-builds. If a fix touches both Vite frontend AND server, both deploys must be triggered separately.

## Push gating

Pre-push hook in this repo enforces:

1. No merge-conflict markers (lesson from World Hub commit `f490f61bf` April 2026 break).
2. No `vercel.json crons` block (Open Claw exclusive policy).
3. No client-side PIN-gate regression (server-side cookie + HMAC only).
4. No `supabase.auth.getUser()` outside `src/lib/auth/*`.

Bypass with `git push --no-verify` only in genuine emergencies.

## What's in scope for this repo vs other repos

In scope (edit here, push here):
- All Bible V8 game logic (`server/`)
- All Vite frontend code (`src/`)
- WebSocket protocol implementation
- Server-side action validators
- Tournament + cash table state machines

Out of scope (edit elsewhere):
- World Hub UI (`Smarter-Poker/Smarter-Poker-World-Hub`)
- Commander Orb (`Smarter-Poker/smarter-poker-commander`)
- Cron handlers (`Smarter-Poker/smarter-poker-workers`)
- Open Claw scheduler config (`Smarter-Poker/Smarter-Poker-World-Hub` → `scripts/openclaw-cron-dispatcher.py`)

## Reference

Master consolidation plan: `~/Documents/SMARTER-POKER-PLATFORM-CONSOLIDATION.md` on Dan's Mac.
URL push-path matrix: `Smarter-Poker-World-Hub/.agent/architecture/url-map.md`.
Agent Rulebook: `Smarter-Poker-World-Hub/.agent/architecture/ONE-SOURCE-OF-TRUTH.md`.
