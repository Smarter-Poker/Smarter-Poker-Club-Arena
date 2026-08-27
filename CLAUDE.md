# Club Arena -- Agent Instructions

## ↗ START HERE: `AGENT-PLAYBOOK.md`

**Before this file, before anything: read [`AGENT-PLAYBOOK.md`](./AGENT-PLAYBOOK.md).**

It is byte-identical in all seven repos and it answers, in one page, how to ship
without losing work: claim your own worktree, commit, push, open a pull request,
stop. It also lists every guard that is protecting you, what each one is telling
you when it speaks, and **where every credential lives** (never the value — the
place). `.github/scripts/estate-integrity.sh` checks hourly that all seven
copies still agree.

If you are lost, cannot find a credential, or something is red and you do not
know why, that file is the answer. This one is the Club Arena detail underneath
it.

---

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

### 1.1.5 SERVER-SIDE PROTECTION (prepared, not yet active)

`.husky/pre-push` is a seatbelt on an unlocked door: `--no-verify` skips it and
a push made through the GitHub API never runs it. The lock is a ruleset, which
GitHub enforces for every client. Private repos need GitHub Pro for that.

`scripts/ci/apply-main-ruleset.mjs` applies it in one command the moment Pro is
on, in two stages:

    GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=1   # block force-push + deletion
    GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=2   # + PR required, checks must pass

Stage 1 changes nothing about how you work and would have prevented the
2026-08-21 rewind that dropped four commits already serving in production.
Stage 2 is the one that makes a red test impossible to land - and it ends
direct pushes to main, so read section 1.3 again after it is applied. The two
required checks (`TypeScript Check`, `Client Unit Tests (vitest)`) already exist
in ci.yml and already run on pull_request.

The token also needs `Administration: Read and write`; one that can push code
cannot change protection rules. The script says which of the two is missing.

### 1.2 Vercel Project

- `hub-vanguard` (`prj_op66GkZyZcygXQKm76iyycfVFAQx`) -- THE REAL ONE. Aliased to `smarter.poker`.
- `smarter-poker` (`prj_FNUaJmcjRnwCSh1JzblIUYuOXDGK`) -- DEAD DUPLICATE. Disconnected. Do not touch.
- There are NO deploy hooks. The Vercel git integration auto-deploys on push to main.

### 1.2.5 HOW A PUSH LANDS NOW (changed 2026-08-21)

The command is unchanged:

    bash scripts/git-safe-push.sh "feat(ca): what changed"

What it does underneath is not. main is protected by a ruleset now, so the
script pushes a branch, opens a pull request, waits for the required checks and
merges it. You do not open the PR yourself and you do not push to main directly.

WHY, because the old path caused three separate incidents in one day:

- it pushed with `--force-with-lease` on every failure path, which REWOUND
  main and dropped four commits already built, synced and serving in
  production;
- it pushed with `--no-verify`, so the pre-push hook - nine house rules, and
  since #149 the test suite - never ran from the one command every agent is
  told to use, and red tests reached main four times;
- it rebased main automatically on conflict, which section 12 forbids.

A pull request cannot do any of those. The branch push still runs the hook, so
a failing test stops you at your own machine rather than stopping everyone.

If it refuses to land, NOTHING was force-pushed and nothing was lost. Read the
output: a hook failure is yours to fix, a `dirty` state means a real conflict
with main, and a timeout leaves the PR open for you to merge by hand.

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
7. POPUPS (Dan 2026-08-20, binding): every popup/toast message renders with
   the First Letter Of Every Word Capitalized, and em dashes are FORBIDDEN in
   popup text. Enforced centrally in `src/utils/popupStyle.ts` via the Toast
   provider — never bypass the Toast layer with a hand-rolled popup, and never
   "fix" a message by disabling the transform. Identical popups also dedupe:
   do not build retry loops that re-toast the same message.

---

8. NEVER PUSH A RED TEST (Dan 2026-08-21, binding). `npx vitest run tests/` in
   `build-for-world-hub.yml` is what PUBLISHES the bundle. A failing test does
   not fail a report - it stops the World Hub sync for every agent and every
   deploy, until a human notices. On 2026-08-21 that happened four times in one
   day, and every one was a test pushed alongside the feature it was meant to
   guard:
   - a test importing a component that had been deleted the day before;
   - a test reading `src/services/soundService.ts` when the file is
     `SoundService.ts` (macOS resolved it, Linux CI did not);
   - a spec asserting the engine sends `card_indices`, committed with no
     implementation beside it - by a commit whose message was "unblock the
     deploy gate";
   - a test still asserting the rounding rule that the same commit's feature
     had just replaced.

   THE RULES:
   - `.husky/pre-push` now runs the tests covering what you touched, in about
     four seconds. Do not `--no-verify` past it.
   - WRITING THE SPEC FIRST IS ENCOURAGED. Committing it red is not. Mark it
     `it.skip()` / `describe.skip()` with a note saying what has to be built,
     and delete the `.skip` in the commit that implements it. A skipped spec
     documents the work; a red one holds the platform hostage.
   - If you deliberately replace behaviour a test pins, UPDATE THAT TEST IN THE
     SAME COMMIT. "Someone else will fix the test" means "nobody ships until
     they do."
   - If you find main already red, fixing it comes before your own work
     (section 4, fix-first). You cannot ship past it anyway.

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
9. Write it down — in your OWN file: `docs/changelog/YYYY-MM-DD-<slug>.md`.
   Do NOT append to `MIGRATION-CHANGELOG.md`. It is frozen as history.
   Measured 2026-08-26: it was the single biggest source of merge conflict in
   this repo — 18 of 108 conflicting pull requests, ahead of both TablePage.tsx
   and ClubHomePage.tsx — because every agent was told to append to the same
   last line of the same 950KB file. Two files written independently cannot
   conflict. See `docs/changelog/README.md`.

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

---

## 11.5 NEVER SPEND REAL CHIPS TO TEST A RULE (added 2026-08-25, binding)

On 2026-08-25 an agent verified a new `atomic_table_buyin` guard by CALLING IT
against production. Two buy-ins succeeded (8.00 and 40.00), the probe's cleanup
then deleted the seat rows directly rather than leaving through
`fn_leave_seat_and_refund` — the refunding path for that seat type; see the
correction under rule 3 below, it is NOT the cash-game path — and 48 chips
left a member wallet and landed nowhere. They were returned to the club
treasury by migration `20260825_return_agent_probe_chips_to_treasury_v2`.

Nothing on the platform caught it. `reconcile_ledger_nightly` compares
`chip_ledger` movement against stored balances, and `atomic_table_buyin` writes
`club_members.chip_balance` directly, so the drift was invisible to the one
check that exists.

**Something catches it now** (migration
`20260825_chips_cannot_leave_the_felt_unnoticed`). A `BEFORE DELETE OR UPDATE
OF left_at` trigger on `table_seats` appends every exit of a NON-ZERO stack to
`ca_seat_stack_exits`, with the DB role and application name that did it.
`fn_unaccounted_seat_exits()` lists the ones with no matching wallet credit,
and `reconcile_ledger_nightly` now files each of those into
`ledger_reconcile_log` as **critical**. The trigger never blocks — a guard that
can refuse a seat exit can strand a player mid-hand — so this makes the failure
LOUD, not impossible. Rule 3 below is still the rule.

`fn_club_chip_circulation()` prints the two pools that reconciliation had never
looked at: `club_members.chip_balance` and `table_seats.stack`. As this was
written that was 121,417,782 chips in member wallets and 1,139,873 on the felt,
none of it reconciled by anything before today.

THE RULE:

1. **A function that moves money is probed inside a transaction you ROLL BACK.**
   Not carefully, not on a test table — rolled back. `scripts/dev/probe-rpc.sql`
   is the pattern; copy it.

2. **What you want from the probe is the error message** — did the guard fire,
   and for the right reason. `GET STACKED DIAGNOSTICS` gives you that, and it
   survives a rollback. The side effects are the part nobody wants.

3. **Never DELETE a `table_seats` row to clean up.** Deleting one skips the
   refund and destroys the chips. If a probe created a seat, the rollback
   removes it.

   **Corrected 2026-08-26 — the original wording here was wrong and would have
   cost someone real money.** It said the refund path is
   `fn_leave_seat_and_refund`. That function is **tournament-only**: its third
   statement is `IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN RETURN
... 'table_not_found'`. Call it on a **cash** table and it returns
   `{"ok": false, "reason": "table_not_found"}`, refunds nothing, and leaves the
   seat exactly where it was. An agent following the old sentence to "safely"
   release a cash seat would have believed the chips were returned when they
   were not. The refund paths by table type:

   | Seat type            | Refund path                                              | Settles into                                                                                                                                        |
   | -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Tournament           | `fn_leave_seat_and_refund(table_id)`                     | `fn_add_chips` -> `club_members.chip_balance`                                                                                                       |
   | Cash, explicit leave | Hetzner engine cash-out (`"Cash-out from table"`)        | `club_members.chip_balance`                                                                                                                         |
   | Cash, tab close      | `player_leave_table(table_id, user_id)` via `sendBeacon` | `club_members.chip_balance` (since `20260826_retire_dead_leave_rpcs_and_fix_tabclose_pool`; it credited the dead `public.wallets` pool before that) |

   `public.wallets` is **not** the live chip pool. It has been frozen since
   2026-08-21 with 732,591,994.33 chips stranded in it. Nothing reads it. If you
   find a money path writing to it, that path is broken.

4. **Helper functions go in `pg_temp`, never `public`.** The same incident left
   three `zz_probe*` functions in the public schema that needed a second
   migration to drop.

5. If you cannot probe a money path without committing, **do not probe it** —
   assert the logic in a unit test and say plainly in the PR that the live path
   was reasoned about rather than executed.

---

## 12. LOCAL CLONE HYGIENE — never rebase main (added 2026-08-21, binding)

**`git pull --rebase origin main` on Dan's Mac is refused by a hook. This is
deliberate. Do not bypass it to "get unstuck" — that is how you get stuck.**

### What went wrong

On 2026-08-21 the Mac clone sat stranded at step 1 of a 10-commit rebase with
conflict markers in 12+ files. That clone's reflog held **54 local commits, 40
`pull --rebase origin main`, and 10 emergency `reset --hard origin/main`
rescues** — a loop, not an accident.

### Why this repo breaks where a normal repo would not

Several agents ship here at once, and they do **not** all push the local commit
object: the GitHub-MCP path re-creates the same CONTENT under a **different
SHA**. So the Mac routinely holds commits whose work is already upstream with
another id. `git pull --rebase` then replays each one onto a branch that already
contains its changes — every hunk conflicts, and origin/main has moved again by
the time anyone looks. Git's own duplicate detection cannot rescue it (the
stranded state even carried a `drop_redundant_commits` marker).

### The guard

`.husky/pre-rebase` (committed — the `.husky/_/pre-rebase` shim already exists,
so every clone gets it) refuses a rebase of `main` that would **replay** commits.
Still allowed, because neither can strand:

- a **fast-forward** (nothing to replay) — the normal way to sync;
- any **feature branch** — rebase those freely.

`scripts/git-safe-push.sh` exports `CA_GIT_GUARD_ALLOW=1` and is unaffected: it
wraps its own rebase in an abort-and-force-push fallback.

### If a clone is already stranded

```bash
bash scripts/git-unstick.sh
```

Aborts any rebase/merge/cherry-pick, clears a stale `index.lock` (only when no
git process is running), saves local-only commits to a dated `backup/unstick-*`
branch, stashes uncommitted edits, and resets `main` to `origin/main`. **Nothing
is deleted** — the backup branch and the stash are both printed at the end.

### The rule

1. The Mac's `main` is a **mirror of origin**, not a place work originates.
   Ship through `scripts/git-safe-push.sh` or the GitHub MCP.
2. To sync it, **fetch + fast-forward** (or `git-unstick.sh`). Never rebase it.
3. Deliberate override, when you actually know why:
   `CA_GIT_GUARD_ALLOW=1 git pull --rebase origin main`.
4. Never run git WRITE commands against the mounted worktree from a sandbox —
   that mount cannot `unlink`, so a `.git/index.lock` it creates is stranded and
   then blocks git on the Mac host too (verified 2026-08-21: write and chmod
   succeed on that mount, unlink fails).

World Hub note: that clone already carries an equivalent hook, but only in
`.git/hooks/` — untracked, so it dies on any fresh clone. This repo's version is
committed precisely so it cannot be lost that way.
