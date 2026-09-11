# Club Arena — Canonical Architecture (2026-04-28)

> **Amended September 9, 2026: Built-In Execution For Significant Work.**
> The user directed that significant Club Arena work have built-in execution
> anchors rather than depend on cron. The owning engine, operations API, or
> always-running service must carry the primary path, with durable obligations,
> idempotency, and restart recovery. Cron is limited to product-time behavior,
> read-only reporting/observability, and bounded housekeeping; it may never be a
> reconciliation, healing, retry, backfill, or release-recovery path. The cron
> routes listed below describe existing deployment locations, not authority for
> business correctness to wait for a scheduler.
> Existing tier ownership remains in force. Replace and verify each primary path
> before retiring its existing schedule. Read the full standard in
> `docs/standards/EVENT-DRIVEN-EXECUTION.md`.

> **AMENDED 2026-09-10 — Club Arena owns both Hetzner release paths.**
> Club Arena's bundle is published by `publish-club-arena.yml` to its own
> Hetzner static origin (`ca-static.smarter.poker`), and the
> World Hub carries ONE rewrite to it. `public/hub/club-arena/` no longer
> exists in the World Hub repo, and `sync-club-arena.sh`, `build-club-arena.sh`
> and the `check-ca-*` gates are deleted. Engine releases are staged,
> validated, and sealed by `auto-deploy-hetzner.yml`. No World Hub workflow,
> Vercel project, direct-main push, or manual SSH command publishes either
> Club Arena runtime.

**Read this first. Do not push code without confirming the layer + table you're targeting matches this doc.**

This document is the single source of truth for Club Arena's structure. Built like ClubGG / PokerBros / WPT Poker — one game-engine tier, one frontend tier, one operations API tier, one workers tier, one Postgres database. Every duplicate that could cause "you fixed it in the wrong place" was hunted down on 2026-04-28; this doc records the canonical pick for each.

When future agents ask "where do I put this fix?" → that answer is in §"Where each kind of fix goes".

---

## §0 — Three-tier topology (locked)

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                            END USERS (mobile + desktop)                  │
   └────────────────┬──────────────────────────────────────┬──────────────────┘
                    │                                      │
                    ▼                                      ▼
   ┌──────────────────────────────────┐    ┌─────────────────────────────────┐
   │  Tier 2 — VITE FRONTEND (SPA)    │    │  Tier 3 — OPERATIONS REST API   │
   │  smarter.poker/hub/club-arena/   │    │  smarter.poker/api/club-arena/* │
   │  Source: ~/Documents/club-arena/ │    │  Source: Smarter-Poker-World-   │
   │  Build: dist/ in CA Actions      │    │   Hub/pages/api/club-arena/*    │
   │  Repo: Smarter-Poker-Club-Arena  │    │  Repo: Smarter-Poker-World-Hub  │
   │  Deploy: atomic Hetzner publish  │    │  Deploy: World Hub's own gated  │
   │   → ca-static.smarter.poker      │    │   release path                  │
   └────────────┬─────────────────────┘    └────────┬────────────────────────┘
                │ WebSocket (gameplay)              │ HTTPS (cashier, club admin,
                │                                   │   agent, settlement, anti-
                │                                   │   cheat, marketplace, etc.)
                ▼                                   ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                  Tier 1 — GAME ENGINE (Hetzner)                        │
   │                  engine.smarter.poker                                 │
   │                  Source: ~/Documents/club-arena/server/                │
   │                  Stack: Node.js + native ws + Docker                   │
   │                  Source of truth: Bible V8 (16 Master Laws)            │
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                  POSTGRES (Supabase project kuklfnapbkmacvwxktbh)       │
   │                  ~290 tables, ~60 RPC functions, RLS-enforced          │
   │                  Migrations: ~/Documents/club-arena/supabase/migrations│
   └────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │     Tier 4 — WORKERS (Hetzner CPX21, dispatched by Open Claw CX23)     │
   │     Source: ~/Documents/smarter-poker-workers/                         │
   │     49 cron paths total, 4 of them new for Club Arena settlement chain │
   │     Open Claw scheduler at 178.104.160.250 (NOT a public DNS)          │
   │     Workers VM at 178.104.180.220, port 8081                           │
   │     Image: ghcr.io/smarter-poker/smarter-poker-workers:latest          │
   └────────────────────────────────────────────────────────────────────────┘
```

### What each tier owns

| Tier                            | What it does                                                                                                                                                                                                                           | What it does NOT                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 — Game engine (Hetzner)       | Single source of truth for table state. State machine (BLINDS → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → SETTLEMENT → CLEANUP). Settlement RPCs called via Supabase. WebSocket fan-out per Law 1.16.                                 | Cashier flows. Agent management. Anything not directly tied to a hand in flight.     |
| 2 — Vite frontend               | UI rendering. Engine state subscription. Hero hole-card management. Animations + sounds. Route between table view and lobby.                                                                                                           | Server-side state. Mutations against the DB (always go through Tier 3).              |
| 3 — Ops REST API (in World Hub) | Cashier (buyin / cashout / approve-cashout / clawback / mint / distribute / transfer). Club admin (create-club, manage-agent, anti-cheat review, audit-trail read). Agent + sub-agent hierarchy. Marketplace. Settlement period close. | Per-hand action processing (engine owns that). Cron handlers (workers own).          |
| 4 — Workers + Open Claw         | All scheduled jobs. Settlement-chain detectors (BBJ, tournament bounty, player-stats refresh, rakeback period close). Content scrapers, leaderboards, freeroll qualification, idempotency-key TTL purge, deploy-error polling.         | Anything triggered by a user action (HTTP requests go to Tier 3).                    |
| Postgres                        | Persistence. RPCs for atomic multi-table mutations (settle_hand_atomically, fn_request_cashout, fn_clawback_chips_atomic, fn_close_settlement_period). RLS for client-side reads.                                                      | Business logic that can't be expressed in SQL — that lives in the engine or ops API. |

---

## §1 — Code locations (no other path is canonical)

| Concern                                                          | Canonical path                                                                     | Repo                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| Game engine source                                               | `~/Documents/club-arena/server/src/`                                               | `Smarter-Poker-Club-Arena` |
| Vite frontend source                                             | `~/Documents/club-arena/src/`                                                      | `Smarter-Poker-Club-Arena` |
| Vite build target                                                | `dist/` built from the exact merged SHA inside `publish-club-arena.yml`            | `Smarter-Poker-Club-Arena` |
| Static assets served at apex                                     | `ca-static.smarter.poker` via the World Hub's rewrite                              | `Smarter-Poker-Club-Arena` |
| Ops REST API routes                                              | `~/Documents/Smarter-Poker-World-Hub/pages/api/club-arena/*.js`                    | `Smarter-Poker-World-Hub`  |
| Ops API helpers (audit, idempotency, sanitize, velocity, notify) | `~/Documents/Smarter-Poker-World-Hub/src/lib/club-arena/*.js`                      | `Smarter-Poker-World-Hub`  |
| Workers cron handlers                                            | `~/Documents/smarter-poker-workers/src/routes/*.ts`                                | `smarter-poker-workers`    |
| Supabase migrations                                              | `~/Documents/club-arena/supabase/migrations/*.sql`                                 | `Smarter-Poker-Club-Arena` |
| Hetzner engine deployment                                        | `.github/workflows/auto-deploy-hetzner.yml` (exact-SHA sealed cutover)             | `Smarter-Poker-Club-Arena` |
| Hetzner frontend publishing                                      | `.github/workflows/publish-club-arena.yml` (atomic origin release)                 | `Smarter-Poker-Club-Arena` |
| Workers deploy script                                            | `~/Documents/smarter-poker-workers/scripts/deploy-workers.sh`                      | `smarter-poker-workers`    |
| Bible V8 spec                                                    | `~/Documents/club-arena/BIBLE-V8-REFERENCE.pdf` + `bible-v8/BIBLE-V8-REFERENCE.md` | `Smarter-Poker-Club-Arena` |
| PokerBros spec                                                   | `~/Documents/Smarter-Poker-World-Hub/docs/POKERBROS_CLONE_SPEC.md` (1686 lines)    | `Smarter-Poker-World-Hub`  |
| Spec authority hierarchy                                         | `~/Documents/CLUB-ARENA-SPEC-AUTHORITY-HIERARCHY.md`                               | local working copy         |
| Tier-E decisions                                                 | `~/Documents/CLUB-ARENA-TIER-E-DECISIONS-2026-04-28.md`                            | local working copy         |
| Master gap ledger                                                | `~/Documents/CLUB-ARENA-MASTER-GAP-LEDGER.md`                                      | local working copy         |

**No other paths host live Club Arena code.** Anything in `~/Documents/_decommissioned-2026-04-27/` is graveyard — read-only history, never push there.

---

## §2 — Live URLs (what's reachable, what owns what)

| URL                                              | HTTP code                              | What's there                                                    | Tier |
| ------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------- | ---- |
| `https://smarter.poker/hub/club-arena`           | 200                                    | Vite SPA (the main player UI)                                   | 2    |
| `https://smarter.poker/hub/club-arena/`          | 308 → strips trailing slash            | —                                                               | —    |
| `https://club.smarter.poker/`                    | 307 → `/hub/club-arena/`               | redirect alias                                                  | —    |
| `https://smarter.poker/api/club-arena/*`         | 200/405/4xx as appropriate             | 67 ops REST routes                                              | 3    |
| `https://engine.smarter.poker/health`            | 200 with `running:true`                | Hetzner game engine                                             | 1    |
| `https://engine.smarter.poker/ws/table/:tableId` | WSS upgrade                            | live WebSocket                                                  | 1    |
| `https://commander.smarter.poker/`               | 200                                    | Commander dashboard (separate product, separate Vercel project) | —    |
| `https://workers.smarter.poker/`                 | 404 (DNS exists, no project)           | Workers are PRIVATE — accessed by Open Claw only                | 4    |
| `http://178.104.180.220:8081/cron/*`             | 200 with Bearer + IP-allowlist         | Workers cron handlers                                           | 4    |
| `http://178.104.160.250` (private)               | Open Claw scheduler — no public access | 4                                                               |

`smarter.poker/club-arena` (no `/hub` prefix) returns 404 — that path is intentionally dead. Don't link to it.

---

## §3 — Hetzner servers (the three VMs we own)

| VM/static origin | Address                     | Purpose                                                                   | Credential owner                        | Deployment path                         |
| ---------------- | --------------------------- | ------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Game engine      | `engine.smarter.poker`      | Runs the sealed `club-arena-engine` release                               | Club Arena repository Actions secrets   | `auto-deploy-hetzner.yml`               |
| Frontend origin  | `ca-static.smarter.poker`   | Serves immutable Vite releases with an atomic `current` selector          | Club Arena repository Actions secrets   | `publish-club-arena.yml`                |
| Workers          | 178.104.180.220 (CPX21)     | Runs `smarter-poker-workers` Docker container; binds 8081 (loopback only) | `~/.ssh/workers_ed25519` (Mac Keychain) | `bash scripts/deploy-workers.sh`        |
| Open Claw        | 178.104.160.250 (CX23 nbg1) | Cron scheduler; calls workers VM `/cron/*` paths                          | `~/.ssh/openclaw*` (Mac Keychain)       | manual edit of `/opt/openclaw/jobs.yml` |

Club Arena publishing never depends on a workstation SSH key. Its workflows
read canonical write-only repository secrets and fail closed when any are
missing or invalid.

---

## §4 — Vercel projects + GitHub repos (post-consolidation, locked)

### GitHub repos (canonical 4)

| Repo                                     | Branch | Purpose                                                        |
| ---------------------------------------- | ------ | -------------------------------------------------------------- |
| `Smarter-Poker/Smarter-Poker-Club-Arena` | main   | Vite frontend + Hetzner engine + Supabase migrations           |
| `Smarter-Poker/Smarter-Poker-World-Hub`  | main   | Apex (smarter.poker) + ops REST API + rewrite to the CA origin |
| `Smarter-Poker/smarter-poker-workers`    | main   | Cron handlers + Hetzner workers VM image                       |
| `Smarter-Poker/smarter-poker-commander`  | main   | Commander dashboard (separate product; not Club Arena)         |

**Archived (do not push to):** `Smarter-Poker/Club-Arena-Design`. Anything else with "club" or "arena" in the name is decommissioned.

### Vercel projects (canonical 6, post-consolidation from 18 → 7 → 6)

The orphan `club-arena` Vercel project (was `prj_oaCq8RYhExLRUYizLG93li0uX468`) was deleted on 2026-04-29 by AG. Verified live: `club-arena.vercel.app` returns 404 (project gone), `smarter.poker/hub/club-arena` still 200 (canonical URL unaffected). Local `~/Documents/club-arena/.vercel/` directory removed.

| Project ID                         | Project name            | Purpose                        | Custom domain                                        |
| ---------------------------------- | ----------------------- | ------------------------------ | ---------------------------------------------------- |
| `prj_vIeaVMjyHZIPgBzTZuzcaPwFlpbP` | smarter-poker-commander | Commander dashboard            | commander.smarter.poker                              |
| `prj_op66GkZyZcygXQKm76iyycfVFAQx` | hub-vanguard            | World Hub apex (smarter.poker) | smarter.poker, www.smarter.poker, club.smarter.poker |
| `prj_uGmblGipHWcpL7lLrCDggK1zP9V8` | master-bus              | Internal                       | —                                                    |
| `prj_3gktr9r6k34oscYINykmPnxmzprw` | identity-dna-engine     | Separate product               | —                                                    |
| `prj_EVHAwaqYFl694Qrl60NEO8iyAQYL` | gto-training-engine     | Separate product               | —                                                    |
| `prj_FlECbqntQtrjJaJ2VTdrD501YHCG` | social-hub-v2           | Separate product               | —                                                    |

---

## §5 — Duplicates found (and what's canonical)

### Duplicate #1 — Vercel `club-arena` project is an orphan ✅ RESOLVED 2026-04-29

Historically, the standalone `club-arena` Vercel project built on pushes to
main. It was deleted and is not a fallback or verification target.

**Canonical now:** push a Club Arena branch → required checks → autopilot merge
→ `publish-club-arena.yml` builds the exact merge and atomically publishes it
to `ca-static.smarter.poker` → World Hub rewrite serves it publicly.

**Status:** ✅ DELETED 2026-04-29 by AG. `club-arena.vercel.app` returns 404 (project removed). Canonical `smarter.poker/hub/club-arena` still 200. Local `.vercel/` config directory removed from repo. Vercel project count went 7 → 6.

### Duplicate #2 — Audit log tables (4 of them; one canonical)

| Table                   | Rows           | Last write | Status                                                                                   |
| ----------------------- | -------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `audit_trail`           | 1 (smoke test) | 2026-04-28 | **CANONICAL** (writes from X7 dual-write helpers)                                        |
| `action_audit_logs`     | 6              | 2026-03-21 | Legacy — 20 ops routes still write here; helpers dual-write to audit_trail going forward |
| `admin_audit_log`       | 8              | 2026-03-06 | Legacy — used by `lib/adminAudit.js` (zero club-arena routes call it directly)           |
| `club_arena_audit_logs` | 0              | never      | Empty since creation; recommend dropping                                                 |

**Canonical:** all new code reads + writes `audit_trail`. Legacy tables stay for the existing dashboards that haven't been ported. Will sunset after the dashboards consolidate.

### Duplicate #3 — Rakeback receipt tables (3 of them)

| Table                                                               | What it stores                                                  | Status                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `rakeback_periods` (header) + `rakeback_period_payouts` (line item) | New per-(period, user) payout schema from X2/X3                 | **CANONICAL** for relaunch                         |
| `rakeback_distributions`                                            | Per-(agent, player) ledger written by legacy auto-settlement.ts | Legacy — keeps writing for now; dashboard reads it |

**Canonical:** new code reads/writes `rakeback_periods` + `rakeback_period_payouts`. The Monday auto-settlement chain writes both so legacy dashboards don't break.

### Duplicate #4 — Idempotency tables (4 of them — actually scope-distinct, not dupes)

| Table                          | Scope                                                      | Status               |
| ------------------------------ | ---------------------------------------------------------- | -------------------- |
| `idempotency_keys`             | General client-supplied UUID dedupe                        | Active               |
| `settlement_idempotency_keys`  | Server-initiated settlement dedupe per (table_id, hand_id) | Active (NEW from X3) |
| `game_action_idempotency_keys` | Per-action engine dedupe                                   | Active               |
| `orb1_idempotency_keys`        | Orb-1 platform-wide dedupe                                 | Active               |

These are intentionally namespaced; not duplicates. Documented to prevent confusion.

### Duplicate #5 — Member tables: `club_members` (BASE) vs `club_memberships` (VIEW) ⚠ CORRECTED 2026-04-29

**Original audit had the canonical pick BACKWARDS.** Verification on 2026-04-29 found:

- `club_members` is the **base table** (1480 rows; all writes go here)
- `club_memberships` is a **VIEW** over `club_members` (`SELECT club_id, user_id, role, agent_id, ... FROM club_members;`)

So `club_members` IS canonical. The 280+ production references to `club_members` are correct. The earlier "canonical = club_memberships" claim was based on naming convention guesswork rather than schema introspection. AG correctly refused the refactor when it detected the mismatch on 2026-04-29.

**Action:** no refactor needed. Both names will keep working — code can read either; writes must go to `club_members`. Architecture-doc table below corrected.

| Table              | Purpose                                                      | Status                                              |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| `club_members`     | **BASE TABLE** — all writes; 1480 rows; 280+ code references | **CANONICAL**                                       |
| `club_memberships` | **VIEW** over `club_members` (1:1 SELECT, all 25 columns)    | Compat alias — readable, but writes must go to base |

**Canonical:** `club_memberships`. New code never reads `club_members`.

### Duplicate #6 — Tournaments: `tournaments` vs `club_tournaments` ✅ RESOLVED 2026-04-29

| Table              | Purpose                                                                                     | Status                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tournaments`      | Bible V8 §11 schema — `clubs.id` FK, `late_reg_levels`, `is_pko`, `is_mystery_bounty`, etc. | **CANONICAL** + `fn_tournament_atomic_register` writes here as of `ba67354e` |
| `club_tournaments` | Older schema; no longer written by any RPC                                                  | Held for read-check before drop (consumer-refactor sweep)                    |

**Status:** ✅ `fn_tournament_atomic_register` refactored to write canonical `tournaments` (migration `20260429000001_x7_refactor_tournament_register.sql`, commit `ba67354e`). RPC verdict probe confirms no `club_tournaments` writes. The legacy table itself stays until a consumer-refactor sweep verifies no live reads.

### Duplicate #7 — Hand history: `hand_history` vs `hand_histories` vs `hands`

| Table                  | Purpose                                                                               | Status                                |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `hand_history`         | Engine-written per-hand JSONB (winners, players, actions, board, hole_cards, summary) | **CANONICAL**                         |
| `hand_histories`       | Older relational version                                                              | Legacy — empty or near-empty; drop    |
| `hands`                | Index of hand IDs (used as hand_id sequence)                                          | Active — engine references via FK     |
| `hand_players`         | Per-(hand, player) row                                                                | Active — used for some replay queries |
| `hand_state_snapshots` | Per-hand state machine snapshots                                                      | Active — used by recovery FSM         |

**Canonical for the player-facing replay:** `hand_history`. `hand_players` + `hand_state_snapshots` are supporting tables.

### Duplicate #8 — Chip escrow: `chip_escrow` vs `chip_escrow_holds`

| Table               | Purpose                                                              | Status                                  |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `chip_escrow_holds` | NEW from X2 — typed hold_type enum, status lifecycle, expires_at TTL | **CANONICAL**                           |
| `chip_escrow`       | Older flat schema                                                    | Empty or near-empty; recommend dropping |

**Canonical:** `chip_escrow_holds`.

---

## §6 — Where each kind of fix goes (the agent decision tree)

| If you're fixing…                                                    | …push to                | …in file/path                                                                                                         |
| -------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Engine state machine bug                                             | Hetzner engine source   | `~/Documents/club-arena/server/src/engine/*.ts`                                                                       |
| WebSocket event emission missing/wrong                               | Hetzner engine source   | `server/src/engine/ServerTableEngine.ts` (or `GameServer.ts` for tournament-level events)                             |
| Hole-card / private-state delivery                                   | Hetzner engine source   | `server/src/handlers/holeCards.ts`, `server/src/lib/HoleCards.ts`                                                     |
| Frontend UI bug (button, animation, layout)                          | Vite frontend source    | `~/Documents/club-arena/src/components/...`                                                                           |
| Frontend state-mapping bug (server snapshot → tableState)            | Vite frontend source    | `~/Documents/club-arena/src/utils/mapEngineSnapshot.ts`                                                               |
| Engine-snapshot → frontend contract                                  | Vite test               | `~/Documents/club-arena/tests/unit/mapEngineSnapshot.test.ts`                                                         |
| Cashier / buy-in / cashout / clawback / mint / distribute / transfer | Ops REST API            | `~/Documents/Smarter-Poker-World-Hub/pages/api/club-arena/*.js`                                                       |
| Club admin (create club, manage agent, anti-cheat review)            | Ops REST API            | same path as above                                                                                                    |
| Settlement period open/close orchestration                           | Ops REST API            | `pages/api/club-arena/settle-period.js`                                                                               |
| Audit logging on a mutation                                          | Use existing helper     | `import { logAudit, extractIP } from '../../../src/lib/club-arena/auditLogger'`                                       |
| Idempotency check                                                    | Use existing helper     | `import { checkIdempotency, cacheResponse } from '../../../src/lib/club-arena/idempotency'`                           |
| Cron handler (every-N-min)                                           | Workers                 | `~/Documents/smarter-poker-workers/src/routes/<name>.ts` + register in `src/index.ts` + add Open Claw scheduler entry |
| Schema migration                                                     | Supabase migrations     | `~/Documents/club-arena/supabase/migrations/<date>_<purpose>.sql`                                                     |
| Postgres RPC                                                         | Supabase migrations     | same path                                                                                                             |
| Bible V8 contract change                                             | Update spec FIRST       | `~/Documents/club-arena/bible-v8/BIBLE-V8-REFERENCE.md` then implement                                                |
| PokerBros UX deviation                                               | Update Tier-E decisions | `~/Documents/CLUB-ARENA-TIER-E-DECISIONS-2026-04-28.md`                                                               |

**If a fix doesn't fit one of those rows, stop. The architecture is wrong, not the fix.**

---

## §7 — Pre-push hooks that MUST stay green

Each canonical repo has pre-push hooks that block pushes if any of these fail:

### Smarter-Poker-Club-Arena

- TypeScript compile (`tsc --noEmit -p tsconfig.json` and `-p server/tsconfig.json`)
- Vitest (when test files changed)
- No client-side PIN regression (server-side PIN gate must stay)

### Smarter-Poker-World-Hub

- Unused hook imports
- SSG-unsafe browser API usage
- No `.single()` in Supabase queries
- No unpatched Supabase imports in API routes
- Auth route canonicalization (`/auth/login` only)
- Unauth'd `/api/` fetch calls
- `node -c` syntax check on every changed `.js`
- Catch-block corruption scan
- Broken import resolution

### smarter-poker-workers

- TypeScript strict-mode compile
- No raw `console.log` outside startup (Sentry only)

### smarter-poker-commander

- TypeScript compile
- PIN-gate server-side enforcement check

If a push gets blocked, READ THE ERROR — never `--no-verify`.

---

## §8 — Canonical addresses + secrets (where to find them)

| Thing                                           | Where                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Supabase project ID                             | `kuklfnapbkmacvwxktbh` (in `.env` files, MCP project_id parameter)                          |
| Hetzner engine deploy SSH                       | Club Arena repository secrets `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`, `HETZNER_HOST_KEY` |
| Hetzner frontend publish SSH                    | Club Arena repository secrets `CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST`, `CA_ORIGIN_HOST_KEY`   |
| Workers VM SSH                                  | `~/.ssh/workers_ed25519` (Mac Keychain only)                                                |
| Open Claw SSH                                   | `~/.ssh/openclaw*` (Mac Keychain only)                                                      |
| GitHub authentication                           | host credential helper / `gh` session; never embed tokens in remote URLs or docs            |
| GHCR PAT (read packages for workers image pull) | Mac Keychain `smarter-poker/github-pat-ghcr-read`                                           |
| Vercel token                                    | not a Club Arena deployment credential; owned by the separate World Hub repository          |
| CRON_SECRET (workers Bearer)                    | `/opt/workers/.env` on workers VM                                                           |

Never commit any of these to git. Never echo them to chat in plaintext.

---

## §9 — Live verification queries (run before AND after every fix)

```sql
-- Settlement chain populated?
SELECT
  (SELECT COUNT(*) FROM rake_records WHERE created_at > NOW() - INTERVAL '1 hour') AS rake_1h,
  (SELECT COUNT(*) FROM agent_commissions WHERE created_at > NOW() - INTERVAL '1 hour') AS commissions_1h,
  (SELECT COUNT(*) FROM rakeback_periods WHERE status='paid' AND paid_at > NOW() - INTERVAL '1 hour') AS rakeback_paid_1h,
  (SELECT COUNT(*) FROM bbj_payouts WHERE created_at > NOW() - INTERVAL '1 hour') AS bbj_1h,
  (SELECT COUNT(*) FROM tournament_bounties WHERE created_at > NOW() - INTERVAL '1 hour') AS bounties_1h,
  (SELECT COUNT(*) FROM audit_trail WHERE created_at > NOW() - INTERVAL '1 hour') AS audit_1h,
  (SELECT COUNT(*) FROM action_audit_logs WHERE created_at > NOW() - INTERVAL '1 hour') AS legacy_audit_1h;

-- Idempotency working (no in_flight stuck)?
SELECT COUNT(*) AS settlements_stuck_in_flight
  FROM settlement_idempotency_keys
 WHERE status='in_flight' AND last_attempt_at < NOW() - INTERVAL '5 minutes';
-- Should be 0.

-- Engine alive?
\! curl -fsS https://engine.smarter.poker/health | python3 -m json.tool

-- Workers crons firing?
\! ssh -i ~/.ssh/workers_ed25519 root@178.104.180.220 \
   "docker logs --tail 100 smarter-poker-workers 2>&1 | grep -E 'cron/(bbj-detect|tournament-bounty|player-stats|rakeback-period)' | head"
```

If any column above shows unexpected zero / non-zero, STOP and investigate before declaring success.

---

## §10 — Tier-E "PokerBros but BETTER" — what shipped vs what's backlog

### Shipped for relaunch (in scope)

- **Provably-fair RNG** — `seed_reveals` table with `seed_commit_sha256` + `seed_plaintext` + pgcrypto-enforced consistency CHECK
- **Anti-cheat flag-only pipeline** — `anti_cheat_flags` table + 738-line admin review endpoint (`anti-cheat.js`) + collusion-scan worker handler
- **Audit trail** — `audit_trail` canonical table + dual-write helpers
- **Settlement chain atomicity + idempotency** — `settle_hand_atomically` RPC + per-(table, hand) dedupe
- **Chat moderation pipeline** — `chat_filter_words` + `chat_moderation_actions` + `chat_mutes` (3 tables)
- **Sub-agent hierarchy** — `sub_agents` + `player_agent_assignments` for proper commission cascade

### Post-launch backlog (Tier E split per CLUB-ARENA-TIER-E-DECISIONS-2026-04-28.md)

- Multi-account detector beyond IP+device match
- Bot timing-variance detector
- Chip-dump detector
- 8 of 12 Law-1.16 events still need explicit emit (hole_cards_dealt, pot_distributed, time_bank_activated, straddle_posted, seat_taken/left, table_paused/resumed, chat_message, online_count, timer_countdown)
- Frontend X6.2 polish (vertical bet slider, multi-table tab pulse indicator, pre-action toggle dynamic labels, hand-history street breakdown, smooth ActionPanel transition)
- Idempotency retrofit on the 47 lower-stakes ops routes (the 20 high-stakes ones already have it)
- Hand history PDF + machine-readable JSON export
- Frame-by-frame replay viewer
- Real-time agent commission preview
- Keyboard shortcuts on desktop (F=fold, C=call, R=raise, Tab=next bet preset)

None of those block real-money traffic. They're closed-beta polish + post-launch UX.

---

## §11 — Decommissioned (read-only, never push to)

These exist in `~/Documents/_decommissioned-2026-04-27/` and are graveyard. Listed here so future agents don't accidentally clone or push into them:

- `Club-Arena-Design` (GitHub repo IS archived; local clone preserved for history)
- `Smarter-Poker-Club-Arena` (older clone path; the canonical clone is at `~/Documents/club-arena/`)
- `club-engine` (predecessor of the current engine; obsolete)
- `club_arena_sandbox` (older Vite scaffolding)
- `world-hub` (older clone path)
- `Swarm`, `Swarm-Operations` (multi-agent experiments; not currently used)
- `hub-vanguard` (older Vercel project local clone; project still exists in Vercel as a name remnant but houses World Hub deployment configs)
- `memory-project`, `openclaw-burnin`

Any path containing `_decommissioned-2026-04-27` is automatically out of scope. If a future agent clones one and starts editing, that's a bug.

---

## §12 — How to know it's still right (six month checklist)

Future agents: re-run this checklist quarterly to catch architectural drift before it bites.

```bash
# 1. Local clean (no rogue club-arena dirs outside canonical paths)
find ~/Documents -maxdepth 2 -type d -name "*club*arena*" 2>/dev/null \
  | grep -v "^/Users.*/_decommissioned\|^/Users.*/club-arena$"
# Expect: empty.

# 2. GitHub repo list (no new repos with "club" or "arena" in the name)
gh repo list Smarter-Poker --json name,archived | jq '.[] | select(.name | test("club|arena"; "i"))'
# Expect: only Smarter-Poker-Club-Arena (archived=false), Smarter-Poker-Diamond-Arena (separate), Club-Arena-Design (archived=true).

# 3. Vercel project list (no new club-arena projects)
vercel projects ls --token $VC | grep -i "club\|arena"
# Expect: only "club-arena" (orphan; see §5#1).

# 4. Live URL probes
for url in https://smarter.poker/hub/club-arena \
           https://engine.smarter.poker/health \
           https://commander.smarter.poker/ \
           https://club.smarter.poker/; do
  echo -n "$url → "
  curl -sI -o /dev/null -w "%{http_code}\n" -m 5 "$url"
done
# Expect: 200, 200, 200, 307.

# 5. Run §9 verification SQL.

# 6. Skim recent commits for the "wrong tier" anti-pattern:
git log --since="3 months ago" --all --pretty=format:"%h %s" \
  | grep -iE "club-arena|club_arena" \
  | grep -v "Smarter-Poker-Club-Arena\|club-arena/(server|src|supabase|tests)"
# Expect: matches in World Hub limited to lib/club-arena/* and pages/api/club-arena/*.
```

If any of those probes fail, this doc is stale — update it before you do anything else.

---

## §13 — Authority

This document is committed to the canonical repo at `Smarter-Poker-Club-Arena/.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` and referenced from `CLAUDE.md`. Any future agent that has access to the repo will read this before pushing. Updating it requires:

1. A real architectural change (not just a code fix)
2. A new dated version (`CLUB-ARENA-CANONICAL-ARCHITECTURE-YYYY-MM-DD.md`) replacing this one
3. The old version moved to `.agent/architecture/_history/`
4. A line in the project's `CHANGELOG.md` noting the architecture change

Compiled by the Cowork session 2026-04-28 in response to Dan's directive: "MAKE SURE THAT IT IS TRULY 100% SET UP EXACTLY THE WAY IT SHOULD BE, LIKE CLUB GG, POKERBROS OR WPT POKER. THAT WE HAVE ZERO DUPLICATES, THAT IT IS TRULY SET UP AS 'ONE SYSTEM' AND ANY OLD PLACES OR POTENTIAL PLACES THAT CAN 'CAUSE ERRORS' ARE DELETED AND THAT THE AGENTS KNOW THE PROPER 'UPDATED STRUCTURE' AND WHERE TO APPLY FIXES AND UPDATES."
