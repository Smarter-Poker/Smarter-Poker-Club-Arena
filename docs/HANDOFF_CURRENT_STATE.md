# CONTINUATION HANDOFF — Club Arena Platform Hardening

**Written:** 2026-08-31 ~12:30 UTC · **Author:** outgoing agent (Cowork session)
**Status at handoff:** Phases 1-5 of 8 COMPLETE and merged. Phase 6 NOT STARTED.

> **SUPERSEDED 2026-08-31 ~14:00 UTC — PHASE 6 IS NOW COMPLETE (PRs #2184,
> #2201).** Everything below about Phase 6 being unstarted is stale; the rest of
> the document still holds. Read
> `docs/audit/2026-08-31-e2e-that-can-report-a-verdict.md` and
> `docs/changelog/2026-08-31-e2e-honesty.md`, then **resume at Phase 7 (the 24
> orphaned pages — needs Dan's per-page call)**.
>
> Two things the next agent should not have to rediscover:
>
> 1. **The E2E credential question in §19 is already answered.** `SP_EMAIL`,
>    `SP_PASS`, `SP_EMAIL_2`, `SP_PASS_2` were added as repository secrets on
>    2026-08-30. Do not ask Dan again.
> 2. **Production is intermittently returning HTTP 503 to a large share of API
>    traffic**, with `PGRST002 - Could not query the database for the schema
cache` behind it. 15,729 503s in one five-minute window (about 28% of
>    requests in that window), then zero, then thousands again. It hits
>    `table_seats` and `insert_hole_cards`, so live seating and dealing are
>    affected. **This has no owner yet and is not a Club Arena spec defect.** The
>    post-deploy suite is red because of it, and those specs should STAY red.

> **PHASE 7 IS ALSO COMPLETE (PR #2265, 2026-08-31).** Resume at **Phase 8**.
> Read `docs/audit/2026-08-31-the-orphans-were-mostly-doors.md` first: the "24
> orphaned pages / ~9,900 lines" figure repeated in §16 and §19 of this document
> was **wrong**. Twelve of the 24 were legacy redirects with no page behind them,
> three were duplicate doors onto components already reachable, and
> `UnionDashboardPage`'s 3,130 lines were never invisible - they serve at
> `/unions/:unionId/operations`. The real set was nine pages. Four are now
> connected, three retired as redirects, and **two remain: `xmtt` and
> `flash-pool`, parked by Dan as a launch decision.** The ratchet ceiling is 2.

> **Read `AGENT-PLAYBOOK.md` and `CLAUDE.md` before touching anything.** This
> document is the session record; those are the binding law.

---

## 1. Executive Continuation Brief

**What is being built.** Club Arena is a Vite + React 19 + TypeScript poker SPA
served inside the smarter.poker Next.js app at
`https://smarter.poker/hub/club-arena/`. Game logic is server-authoritative on a
Hetzner node (`server/`); data, auth and realtime are Supabase.

**The objective of THIS work.** Dan asked for a platform-wide hardening sweep,
broken into **8 phases**, each fully built, wired, tested and verified in
production before moving on. After each phase Dan asks for a verification pass
("make sure everything was 100% completed... check for any and all bugs, gaps,
stubs, errors, regressions or wiring issues"). That cadence is expected to
continue.

**Current phase:** Phase 5 of 8 complete. **Phase 6 (E2E honesty) is next and has
not been started.**

**Major work completed:** a navigation/copy law with three CI gates and four law
tests; a 20-PR backlog triage backed by a purpose-built supersession scanner; a
**real privilege-escalation vulnerability found and fixed** (unauthenticated
callers could set any club role); and the discovery that the unused-index
evidence mechanism could never reach a verdict, plus the fix that lets it.

**The single most important thing to understand.** Three times this session, a
**gate that documented a promise it did not enforce** was the actual bug. The
title-case gate said expression values are "cased at their source" and nothing
checked the source. The definer gate printed _"Never from a parameter"_ and
cleared a function that took its actor from a parameter. The index mechanism
demanded uninterrupted history on a server that restarts nightly. **When you find
a safeguard here, verify it can actually fire before trusting it.**

**First action:** run the Phase 0 checklist in §22. Do not assume this document
is current — the repo moves fast (38 commits landed on `main` during this
session from other agents).

---

## 2. User Requirements And Working Preferences

### Non-negotiable, stated by Dan (verbatim where it matters)

| Requirement                                                                                                                                                               | Source            | Status                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| "WHEN YOU OPEN THE HAMBURGER MENU INSIDE THE CLUB ARENA, THE TICKER SHOULD NEVER APPEAR OVER THIS, THIS SHOULD EVER ONLY APPEAR WHILE LIVE AT A TABLE, NOT ANYWHERE ELSE" | Dan, this session | **DONE**, pinned                                                          |
| "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU MUST BE CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE"                                               | Dan, this session | **DONE**, gated                                                           |
| "MAKE SURE EVERY PAGE AND SUBPAGE IS FULLY BUILD OUT AND ACTUALLY CONNECTED AND FUNCTIONAL"                                                                               | Dan, this session | **PARTIAL** — menu→route proven; 24 routes still have no way in (Phase 7) |
| Phase reporting format: "PHASE X OF Y IS DONE, with the summary, followed by READY TO START PHASE X+1 OF Y"                                                               | Dan, this session | Follow exactly                                                            |
| "YOU DECIDE THE BUILD ORDER"                                                                                                                                              | Dan, this session | Order chosen by outgoing agent; see §21                                   |

### Standing house rules (from CLAUDE.md, binding)

- **HORSES ARE PLAYERS** (§10.5). Never write `is_horse` to exclude a horse from
  anything a human gets. Timing counts as treatment. One sanctioned asymmetry:
  hand-history retention (7 days, Dan's call, a config row — do not "fix" it).
- **ANIMATIONS MUST ALWAYS PLAY** and **NEVER AUTO-CHANGE TABLES** (§10.6).
- **Popups**: Title Case, no em dashes, via the Toast layer only.
- **No emoji in source.** Never call horses "bots".
- **Mobile-first at 375px**, then scale up.
- **`.maybeSingle()` never `.single()`.**
- **NEVER PUSH A RED TEST** (§5.8). A red test blocks the World Hub publish for
  every agent.
- **NEVER SPEND REAL CHIPS TO TEST A RULE** (§11.5). Probe money paths inside a
  rolled-back transaction. **This extends to privilege paths** — the Phase 4
  vulnerability was proven by reading `pg_proc`/ACLs, never by calling it.
- **Never rebase `main`** (§12). Use `scripts/git-safe-push.sh` or a worktree.
- Write changelogs to **your own file** `docs/changelog/YYYY-MM-DD-<slug>.md`,
  never append to `MIGRATION-CHANGELOG.md`.

### Working preferences observed

- Dan wants **evidence, not assertions**. Every claim of completion was expected
  to carry a command output or a production query behind it.
- Dan reacts well to being told **"my earlier claim was wrong"** — that happened
  three times this session and was welcomed each time.
- Concise summaries; no filler; no "I can provide more detail if needed".

---

## 3. Project And Repository Identity

```text
Project Name:        Club Arena (part of the smarter.poker platform)
Repository Root:     /Users/smarter.poker/Documents/club-arena          [CONFIRMED]
Current Working Dir: /Users/smarter.poker/Documents/club-arena          [CONFIRMED]
Git Repository:      git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git [CONFIRMED]
Current Branch:      main                                              [CONFIRMED]
Local HEAD:          ef1f656003  (38 commits BEHIND origin/main)       [CONFIRMED]
origin/main:         fe058a998f                                        [CONFIRMED]
Remote Names:        origin (fetch+push, SSH)                          [CONFIRMED]
Primary Framework:   Vite + React 19 + TypeScript, React Router v7      [CONFIRMED]
Package Manager:     npm (package-lock.json present)                    [CONFIRMED]
Runtime (local):     node v26.3.0, npm 11.16.0                          [CONFIRMED]
Runtime (CI):        Node 20 (ci.yml setup-node)                        [CONFIRMED]
Database:            Supabase PostgreSQL 17.6, project kuklfnapbkmacvwxktbh [CONFIRMED]
Hosting:             Vercel project `hub-vanguard` via the World Hub repo [CONFIRMED via CLAUDE.md]
Game engine:         Hetzner VPS, server/src/index.ts, PM2             [CONFIRMED via CLAUDE.md]
External services:   GitHub Actions, pg_cron, Sentry, OneSignal (dead)  [CONFIRMED]
```

**Sibling repo:** `/Users/smarter.poker/Documents/Smarter-Poker-World-Hub`
(Next.js). Club Arena builds into it; it owns `pages/api/club-arena/*` and the
Stories component referenced in §16.

---

## 4. Repository Map (relevant paths only)

```text
club-arena/
├── CLAUDE.md                      BINDING law for this repo. Read first.
├── AGENT-PLAYBOOK.md              Byte-identical across 7 repos. How to ship.
├── .agent/
│   ├── workflows/                 supabase-security.md, migration-safety.md, deploy.md
│   ├── architecture/              CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md
│   └── handoffs/                  Other agents' handoffs (do not delete)
├── .husky/
│   ├── pre-push                   ~10 house gates + the test suite. MODIFIED (Phase 2).
│   ├── pre-rebase                 Refuses replaying a rebase of main
│   ├── post-checkout              Snapshots a dirty shared clone to refs/wip/
│   └── reference-transaction      Fires before a ref move. See Phase 1 finding.
├── .github/workflows/
│   ├── ci.yml                     6 required checks. MODIFIED (Phase 2).
│   ├── build-for-world-hub.yml    PUBLISHES the bundle. A red test stops it.
│   └── post-deploy-e2e.yml        PHASE 6 TARGET — workflow_run triggered
├── scripts/ci/
│   ├── check-title-case.mjs       Pre-existing. JsxText only (documented gap).
│   ├── check-nav-title-case.mjs   ★ CREATED Phase 2. Source-side title case.
│   ├── check-definer-authorization.mjs  MODIFIED Phase 4. +spoofableIdentityFallback
│   ├── check-migrations-applied.mjs     Repo↔prod consistency. Bit me in Phase 5.
│   ├── gen-schema-manifest.mjs    Regenerates the 3 manifests. Needs service role.
│   └── supabase-*-manifest.json   Generated. Refreshed Phase 5.
├── scripts/dev/
│   └── pr-supersession-scan.py    ★ CREATED Phase 3. Is a PR already on main?
├── src/
│   ├── App.tsx                    ~126 routes. Source of truth for connectivity.
│   ├── config/
│   │   ├── clubArenaNavigation.ts       MODIFIED Phase 2 (title case)
│   │   ├── arenaSectionNavigation.ts    (already cased)
│   │   ├── clubOperationsNavigation.ts  MODIFIED Phase 2
│   │   └── clubIntegrityNavigation.ts   MODIFIED Phase 2
│   ├── components/navigation/     Breadcrumbs/SideNav/NavItem/index.ts DELETED Phase 2
│   │   ├── HamburgerMenu.tsx      MODIFIED Phase 1 (tc() at every render site)
│   │   └── HamburgerMenu.module.css  MODIFIED Phase 1 (z 9450/9500)
│   └── components/tournament/
│       └── TournamentStartingTicker.tsx  MODIFIED Phase 1 (atLiveTable gate)
├── supabase/migrations/           ~960 files. APPEND-ONLY. Never edit history.
├── tests/                         ~706 files / ~10,012 tests
└── docs/
    ├── audit/                     ★ 3 new audits this session
    ├── changelog/                 ★ 4 new changelogs this session
    └── HANDOFF_CURRENT_STATE.md   ★ THIS FILE
```

**Do not edit:** `supabase/migrations/*` history, `.agent/handoffs/*` belonging to
other agents, `MIGRATION-CHANGELOG.md` (frozen).

---

## 5. Applicable Instructions And Constraints

| File                                                                  | Scope                       | Must-know                                                                                                 |
| --------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `AGENT-PLAYBOOK.md`                                                   | All 7 repos, byte-identical | Claim your own worktree, commit, push, open PR, stop. Credential locations.                               |
| `CLAUDE.md`                                                           | This repo                   | Deploy path, 8 code-safety rules, horses law, animation law, §11.5 money-path rule, §12 never-rebase-main |
| `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` | Architecture                | **Wins over CLAUDE.md if they conflict**                                                                  |
| `.agent/workflows/migration-safety.md`                                | Migrations                  | Tier system; Tier 3 needs a pasted ROLLBACK                                                               |
| `.agent/workflows/supabase-security.md`                               | DB security                 | Bucket A-D remediation protocol                                                                           |
| `~/Documents/Smarter-Poker-World-Hub/CLAUDE.md`                       | Platform                    | Vercel `hub-vanguard` only; cron governance §11                                                           |

**Known conflict:** CLAUDE.md §1.1.5 says the main-branch ruleset is "prepared,
not yet active" and `.husky/pre-push` check 0 says nothing enforces server-side.
**Both are stale.** Verified against the live API 2026-08-28 and again by
behaviour this session: the ruleset IS active, direct pushes to `main` are
refused, and every merge went through a PR with 6 required checks.

---

## 6. Complete Discovery Record

### 6.1 Deploy pipeline (confirmed by use)

Club Arena does **not** deploy directly. Push to `club-arena` `main` →
`build-for-world-hub.yml` builds and syncs into the World Hub repo → Vercel
`hub-vanguard` auto-deploys → `https://smarter.poker`. Verified end-to-end in
Phase 1: my commit `9e27bf5db` produced World Hub sync commit `31794b1e`, and I
confirmed the cased strings in the deployed `HamburgerMenu-*.js` chunk.

`main` is protected by a GitHub ruleset with `bypass_actors: []` and 6 required
checks: TypeScript Check, Client Unit Tests (vitest), Server Engine, Production
Build, CSS Beat E2E, Silent Revert Guard.

### 6.2 The two shipping paths, and the residue they create

`git push` moves the commit object. The **GitHub-MCP path re-creates the same
content under a different SHA**. CLAUDE.md §12 documents this as why
`pull --rebase` strands the shared clone. **Second, unmeasured consequence: a PR
whose content landed by the other path stays open forever**, looking unshipped,
because git sees no relation between the commits. That is the root cause of the
120-PR backlog (§7.3).

### 6.3 Navigation architecture

Five surfaces render clickable destinations from config registries through
expressions (`{item.label}`): HamburgerMenu, ArenaSectionRail, ClubOperationsRail,
QuickActionsBar, ClubBottomNav. A sixth, Breadcrumbs, **had zero callers in its
entire git history** — deleted with SideNav, NavItem and their barrel.

Two registries compose paths from templates (`clubPath('/finance')`), so **a
regex audit under-reports reachability by six routes**; the law test therefore
_calls_ the builders. Static-only reports 85/126 reachable; calling finds 91.

### 6.4 The statistics environment (critical for any DB perf work)

- PostgreSQL **17.6**. `pg_stat_database.stats_reset` is **NULL** — never
  explicitly reset — which is misleading.
- The server **restarts roughly nightly** (01:15, 02:15, 04:32, 04:33 on
  consecutive days). Each restart wipes `idx_scan`.
- Calibration: `hand_history` showed 105,619 inserts against a documented
  ~221,000/day = 0.478 days, matching a 10h24m uptime.
- **Any `idx_scan = 0` reading means "unused since the last restart", nothing
  more.**

### 6.5 Column-level grants on `profiles`

`profiles` uses **column-level** SELECT grants, so its table ACL looks odd
(`authenticated=adxtm`, no table-wide `r`) but is intentional. `authenticated`
can read ~100 named columns; `anon` can read only `(bio, player_tags)`.

### 6.6 Existing gates and their real coverage

| Gate                              | Covers                                | Documented blind spot                                                                  |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `check-title-case.mjs`            | JsxText nodes                         | **Expressions — "cased at their source", unenforced until Phase 2**                    |
| `check-definer-authorization.mjs` | Definer writers reachable by browsers | **Cleared anything mentioning `auth.uid()`, incl. spoofable COALESCE — fixed Phase 4** |
| `check-migrations-applied.mjs`    | Migration objects exist live          | Needs manifest refresh in the same PR                                                  |
| `reference-transaction` hook      | Orphaned commits on ref move          | **Fast-forward reset over a dirty tree — unfixable, see §15**                          |

### 6.7 Technical debt observed (not addressed)

- ~99 open PRs, most 800-1,100 commits behind `main`.
- `--all` mode of `check-definer-authorization.mjs` has been failing on pristine
  `main` with **68 offenders** since before this session (append-only history).
- 128 tables have RLS enabled with **zero policies** (fail-closed, so not a leak,
  but each is either service-role-only by design or a silently broken feature).
- `MIGRATION-CHANGELOG.md` frozen at ~950KB after causing 18 of 108 PR conflicts.

---

## 7. Work Completed During This Chat

All nine PRs below are **MERGED and verified on `origin/main`**.

### 7.1 Phase 1 — Hamburger menu law (PR #2006, sha `9e27bf5db`)

- `TournamentStartingTicker.tsx`: route gate `insideClub` (`/clubs/*` OR
  `/table*`) → **`atLiveTable`** (`/table*` only).
- `HamburgerMenu.module.css`: `.backdrop` 1100→**9450**, `.drawer` 1200→**9500**
  (ticker is 9400; dialogs 9600+).
- `HamburgerMenu.tsx`: imported `formatPopupText` as `tc`, applied at every
  label/description/group/chip render site.
- Created `tests/unit/hamburgerMenuLaw.test.ts` — 32 tests incl. one per menu
  destination.
- **Verified in the deployed bundle**, not just the repo: grepped
  `HamburgerMenu-*.js` and `HamburgerMenu-*.css` on production for the cased
  strings and the z-index values.

### 7.2 Phase 2 — Nav law everywhere (PRs #2032, #2087, #2099)

- **Created `scripts/ci/check-nav-title-case.mjs`** — TypeScript-AST gate
  requiring `label`/`description`/`eyebrow` string literals in 6 named files to
  be Title Cased at source. Shares its acronym list byte-for-byte with the
  sibling gate.
- **Fixed 55 violations** at source; 3 computed ternary descriptions by hand (the
  AST gate cannot see non-literals — found by the law test, not the gate).
- Wired into `.husky/pre-push`, `.github/workflows/ci.yml`, `scripts/ci/all-gates.sh`.
- **Deleted the dead nav cluster** (7 files): Breadcrumbs, SideNav, NavItem + barrel.
- **Created `tests/unit/everyRouteIsReachableLaw.test.ts`** — the inverse audit as
  a one-way ratchet. 126 routes, 91 reachable, **35 allowlisted** (11 legitimate,
  **24 orphaned product pages**). Proven in all three failure directions.
- #2099 fixed stale doc drift in my own gate header, caught by the verification pass.

### 7.3 Phase 3 — PR backlog triage (PRs #2111, #2116)

- **Created `scripts/dev/pr-supersession-scan.py`** — samples ≤40 substantive
  added lines per PR and checks verbatim presence in a `main` corpus.
- Measured all 121 open PRs: **22 already 100% on main** (incl. 4 empty diffs),
  29 at 80-99%, 14 at 50-79%, 12 at 20-49%, **44 genuinely unshipped**.
- **Closed 20 PRs** with evidence in each comment (19 superseded + #2040, a
  byte-identical duplicate of #2045 found by hashing all 98 open diffs).
- **Deliberately left #2101/#2100/#2067 open** despite 100% scores — live work
  with auto-merge armed. **#2101 and #2100 merged minutes later**, confirming
  the call.
- Wrote `docs/audit/2026-08-31-pr-backlog-triage.md` ranking the remaining 44.

### 7.4 Phase 4 — Privilege escalation (PR #2130, sha `5ce270496`)

**A real vulnerability.** `fn_club_set_member_role` derived identity from:

```sql
v_actor := COALESCE(auth.uid(), p_actor_user_id);
```

`auth.uid()` is NULL for `anon`, so an unauthenticated caller fell through to a
**caller-supplied** actor. The function held EXECUTE for **PUBLIC and anon**
(`proacl` was `=X/postgres | anon=X/postgres | ...`) and is reachable at
`/rest/v1/rpc/fn_club_set_member_role`. Anyone with the publishable anon key
could pass a club owner's uuid and set any member's role, `co_owner` included.

- Migration `20260831_anon_cannot_name_itself_the_actor.sql`: identity now from
  `auth.uid()`, with a trusted-backend escape hatch
  (`COALESCE(auth.role(),'service_role')='service_role'`); **PUBLIC and anon
  revoked** (revoking anon alone would have left PUBLIC standing).
- Extended the gate with `spoofableIdentityFallback()`.
- Created `tests/anon-cannot-name-itself-the-actor.test.ts` (7 tests).
- **Scope checked:** 7 functions use that COALESCE; only this one was both
  anon-executable and parameter-fed. **Zero anon-callable definer writers with a
  spoofable actor now remain.**

### 7.5 Phase 5 — Index evidence (PR #2149, sha `cde74ee3f`)

**Not one index dropped — that is the finding.** The 08-26 snapshot mechanism
required two captures sharing one `postmaster_start`; snapshots were daily and
the server restarts daily, so all 6 captures sat in 6 epochs with **0.000 days**
of uninterrupted history each. `fn_truly_unused_indexes(n)` could never return a
row for any `n > 0`.

- Rewrote it to **sum per-epoch deltas**; kept fail-closed.
- Cron `41 4 * * *` → **`41 */2 * * *`**; added a daily prune (`17 5 * * *`).
- Added `fn_prune_index_usage_snapshots` and **revoked it from PUBLIC/anon/
  authenticated** — my own Phase 4 gate blocked the push until I did.
- Refreshed the 3 schema manifests (picked up my function **plus 9 objects other
  agents had applied but never manifested**).

---

## 8. Visual And Product Decisions

**No new visual assets were created or approved this session.** No reference
images were supplied. No mockups exist for this work.

Locked visual/behavioural decisions made:

| Decision               | Value                                                      | Locked by                                 |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| Ticker visibility      | `/table/*` **only**                                        | Dan verbatim + `hamburgerMenuLaw.test.ts` |
| Drawer stacking        | backdrop 9450, drawer 9500                                 | `hamburgerMenuLaw.test.ts`                |
| Menu copy              | Title Case at source, every label/description              | `check-nav-title-case.mjs`                |
| Deleted nav components | Breadcrumbs, SideNav, NavItem, barrel — **do not restore** | `navigationSurfacesLaw.test.ts` comment   |

**Obsolete/rejected:** the pre-2026-08-30 ticker rule ("only inside the club",
`/clubs/*`) is **superseded**. If you see `startsWith('/clubs/')` in the ticker's
visibility gate, that is a regression.

---

## 9. Functional And Architectural Decisions

| Area                                                              | State                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Ticker route gate                                                 | **Implemented + pinned**                                              |
| Menu Title Case (source-side)                                     | **Implemented + gated**                                               |
| Menu→route connectivity                                           | **Implemented + pinned** (59 destinations, 0 dead)                    |
| Route→nav reachability (inverse)                                  | **Implemented as a ratchet**; 24 pages still orphaned                 |
| Definer/anon privilege surface                                    | **Implemented**; 0 spoofable anon writers remain                      |
| Index evidence accumulation                                       | **Implemented**; verdict expected ~2026-09-07                         |
| E2E post-deploy verification                                      | **NOT STARTED** — Phase 6                                             |
| Orphan page connect-or-retire                                     | **NOT STARTED** — Phase 7, needs Dan's product calls                  |
| OneSignal dead path (#1498)                                       | **NOT STARTED** — Phase 8                                             |
| Vestigial Vercel project (#997)                                   | **NOT STARTED** — Phase 8                                             |
| Migration repo↔prod reconciliation                                | **NOT STARTED** — Phase 8                                             |
| Horses law, animation law, wallets, rake, BBJ, tournaments, spins | **UNTOUCHED this session.** No changes made. Do not assume any state. |

---

## 10. Exact Current State

```text
Branch:            main
Local HEAD:        ef1f656003   (38 BEHIND origin/main)   [CONFIRMED]
origin/main:       fe058a998f                             [CONFIRMED]
Local commits:     0
Staged:            0
Modified:          5   (ALL other-agent work, all already on origin/main)
Untracked:         4   (ALL other-agent work, all already on origin/main)
My worktrees:      0 remaining (all removed)
Production:        /api/health ok, version 49a8f13d, DB 306ms  [CONFIRMED 12:30 UTC]
Club Arena:        HTTP 200                                     [CONFIRMED]
Open PRs:          99                                           [CONFIRMED]
Open issues:       #1634, #1498, #997, #375                     [CONFIRMED]
```

**The 9 dirty files in the shared clone are NOT mine.** Every one already exists
on `origin/main`; the clone is simply 38 behind. **Do not commit, revert, or
clean them.**

### Live database state (all CONFIRMED by query 12:29 UTC)

```text
fn_club_set_member_role  anon EXECUTE = false   authenticated = true
index snapshot cron      41 */2 * * *
index prune cron         17 5 * * *
snapshot rows            11,102 across 6 epochs
observed evidence        0.294 days
fn_truly_unused_indexes(7) → 0 rows  (correctly refusing)
fn_prune_index_usage_snapshots  anon EXECUTE = false
```

---

## 11. Changed-File Ledger

| File                                                                            | Status          | Purpose          | What Changed                              | Verified         | Committed |
| ------------------------------------------------------------------------------- | --------------- | ---------------- | ----------------------------------------- | ---------------- | --------- |
| `src/components/tournament/TournamentStartingTicker.tsx`                        | Modified        | Ticker           | `insideClub`→`atLiveTable`, `/table` only | Prod bundle grep | #2006     |
| `src/components/navigation/HamburgerMenu.tsx`                                   | Modified        | Menu             | `tc()` at every render site               | Prod chunk grep  | #2006     |
| `src/components/navigation/HamburgerMenu.module.css`                            | Modified        | Menu             | z 9450/9500                               | Prod CSS grep    | #2006     |
| `tests/unit/hamburgerMenuLaw.test.ts`                                           | Created         | Law              | 32 tests                                  | Ran green        | #2006     |
| `scripts/ci/check-nav-title-case.mjs`                                           | Created         | Gate             | Source-side title case                    | Both directions  | #2032     |
| `src/config/clubArenaNavigation.ts`                                             | Modified        | Registry         | Title Case + 3 ternaries                  | Gate + tests     | #2032     |
| `src/config/clubOperationsNavigation.ts`                                        | Modified        | Registry         | Title Case                                | Gate             | #2032     |
| `src/config/clubIntegrityNavigation.ts`                                         | Modified        | Registry         | Title Case                                | Gate             | #2032     |
| `.husky/pre-push`                                                               | Modified        | Gate wiring      | +check-nav-title-case                     | Ran on push      | #2032     |
| `.github/workflows/ci.yml`                                                      | Modified        | Gate wiring      | +check-nav-title-case                     | CI green         | #2032     |
| `scripts/ci/all-gates.sh`                                                       | Modified        | Gate wiring      | +check-nav-title-case                     | —                | #2032     |
| `tests/unit/navigationSurfacesLaw.test.ts`                                      | Created         | Law              | 7 tests, 5 surfaces                       | Ran green        | #2032     |
| `src/components/navigation/{Breadcrumbs,SideNav,NavItem}.{tsx,css}`, `index.ts` | **DELETED** (7) | Dead code        | Zero callers ever                         | 404 on main      | #2087     |
| `tests/unit/everyRouteIsReachableLaw.test.ts`                                   | Created         | Ratchet          | 126 routes, 35 allowlisted                | 3 failure modes  | #2087     |
| `tests/unit/resetGuardCannotSaveTheWorktree.test.ts`                            | Created         | Trap guard       | 5 tests                                   | Seeded red       | #2069     |
| `scripts/dev/pr-supersession-scan.py`                                           | Created         | Tool             | PR-vs-main scanner                        | Ran on 121 PRs   | #2111     |
| `docs/audit/2026-08-31-pr-backlog-triage.md`                                    | Created         | Audit            | 44 ranked                                 | —                | #2111     |
| `scripts/ci/check-definer-authorization.mjs`                                    | Modified        | Gate             | +spoofableIdentityFallback                | Both directions  | #2130     |
| `supabase/migrations/20260831_anon_cannot_name_itself_the_actor.sql`            | Created         | **Security fix** | anon spoofing closed                      | Prod query       | #2130     |
| `tests/anon-cannot-name-itself-the-actor.test.ts`                               | Created         | Law              | 7 tests                                   | Ran green        | #2130     |
| `docs/audit/2026-08-31-anon-actor-spoofing.md`                                  | Created         | Audit            | Vulnerability record                      | —                | #2130     |
| `supabase/migrations/20260831_index_evidence_that_can_actually_accumulate.sql`  | Created         | DB               | Cross-epoch reader + prune                | Prod query       | #2149     |
| `supabase/migrations/20260831b_index_evidence_cron_and_bigint_cast.sql`         | Created         | DB               | Cast + cron cadence                       | Prod query       | #2149     |
| `tests/unit/indexEvidenceCanAccumulate.test.ts`                                 | Created         | Law              | 8 tests                                   | Ran green        | #2149     |
| `scripts/ci/supabase-*-manifest.json` (3)                                       | Modified        | Generated        | Manifest refresh                          | CI green         | #2149     |
| `docs/audit/2026-08-31-index-evidence-that-can-accumulate.md`                   | Created         | Audit            | Why nothing dropped                       | —                | #2149     |
| `docs/changelog/2026-08-3*.md` (4)                                              | Created         | Changelog        | Per-phase records                         | —                | various   |

**User/other-agent owned — DO NOT TOUCH:** the 9 dirty files listed in §10.

---

## 12. Asset Ledger

**No visual assets were created, uploaded, approved, or rejected this session.**
No reference images were supplied by Dan for this work. Nothing is pending
persistence. If a future phase involves visual work, there is no locked
reference to inherit from this session.

---

## 13. Commands And Tools Used

| Command                                                    | Where        | Purpose                               | Result                 | Rerun?                      |
| ---------------------------------------------------------- | ------------ | ------------------------------------- | ---------------------- | --------------------------- |
| `git worktree add <path> -b <branch> origin/main`          | shared clone | Isolated workspace                    | Worked                 | Yes, always                 |
| `ln -sfn ~/Documents/club-arena/node_modules node_modules` | new worktree | **Required** — worktrees have no deps | Worked                 | Yes, every new worktree     |
| `npx vitest run tests/unit`                                | worktree     | Unit suite                            | 473 files / 6,725 pass | Yes                         |
| `npx tsc --noEmit`                                         | worktree     | Typecheck                             | exit 0                 | Yes                         |
| `node scripts/ci/<gate>.mjs`                               | worktree     | House gates                           | OK                     | Yes                         |
| `node scripts/ci/gen-schema-manifest.mjs`                  | worktree     | Manifest refresh                      | 958 tables/2448 fns    | Only when adding DB objects |
| `gh pr create / merge --squash --auto`                     | worktree     | Ship                                  | Worked                 | Yes                         |
| `python3 scripts/dev/pr-supersession-scan.py <PR...>`      | worktree     | Triage                                | Worked                 | Yes                         |
| Supabase MCP `apply_migration`                             | —            | **Only sanctioned DDL path**          | Worked                 | Yes                         |

**Environment gotchas that cost real time:**

- **macOS ships bash 3.2** — no `mapfile`. Use python or a for-loop.
- **`$?` after a pipeline reports the LAST command**, not `node`. This made me
  wrongly believe `--all` was green. Capture exit codes without piping.
- **Background processes do not survive** the host_terminal connection. Long runs
  must be chunked into foreground calls.
- **`gh pr diff` is required** on this private repo; the plain `.diff` URL 404s.
- GitHub API **rate-limits at 5,000/hr** — I hit it twice.

---

## 14. Verification And Test Results

| Verification                   | Method                        | Result                                        | Phase       | Follow-Up   |
| ------------------------------ | ----------------------------- | --------------------------------------------- | ----------- | ----------- |
| Full test suite                | `npx vitest run` by directory | **706 files / 10,012 tests PASS**             | after P2    | —           |
| Unit suite                     | `npx vitest run tests/unit`   | 473 / 6,725 PASS                              | P5          | —           |
| Typecheck                      | `npx tsc --noEmit`            | exit 0                                        | every phase | —           |
| House gates (8)                | `node scripts/ci/*.mjs`       | All OK                                        | P4          | —           |
| Nav gate, both directions      | Seeded lowercase label        | Red then green                                | P2          | —           |
| Route ratchet, 3 failure modes | Seeded each                   | All red, restored green                       | P2          | —           |
| Reset-guard trap               | Seeded `git stash create`     | Red then green                                | P1          | —           |
| Definer gate, both directions  | Vulnerable + repaired shapes  | Correct both                                  | P4          | —           |
| Production bundle content      | curl + grep deployed chunks   | Cased strings present, old absent             | P1/P2       | —           |
| Production DB state            | Supabase SQL                  | All assertions hold                           | P4/P5       | —           |
| `/api/health`                  | curl                          | ok, DB 306ms                                  | P5          | —           |
| **CI required checks**         | GitHub                        | Green on all 9 merges                         | all         | —           |
| **Post-deploy E2E**            | —                             | **NOT RUN — 7 skipped + 1 failure in last 8** | —           | **PHASE 6** |
| Rollback of migrations         | —                             | **NEVER TESTED**                              | P4/P5       | See §16     |
| Visual/responsive/375px        | —                             | **NEVER TESTED** — no UI rendering verified   | P1/P2       | See §16     |
| Accessibility                  | —                             | **NEVER TESTED**                              | —           | —           |
| Performance/bundle size        | —                             | **NEVER MEASURED**                            | —           | —           |

**Failures encountered and resolved:** CI failed once on #2149
(`check-migrations-applied` — stale manifest); my own tests failed 4 times
correctly (see §15).

---

## 15. Setbacks, Failed Approaches, And Lessons

1. **Phase 1's premise was wrong.** I claimed uncommitted work was at imminent
   risk. **Untracked files survive `git reset --hard`** (proven in a scratch
   repo); only `git clean -fd` removes them and nothing runs it. I corrected this
   publicly rather than building on it.

2. **A rescue hook that would have made things worse.** I wrote a working-tree
   snapshot for `reference-transaction`, then probed inside a real reset:

   ```text
   before: worktree f.txt = "IMPORTANT LOCAL EDIT"
   PROBE:  worktree f.txt = [v2]        <- origin content ALREADY there
   PROBE:  git status     = [M  f.txt]  <- git's OWN staged change
   ```

   So the dirty-check false-positives on every clean sync reset, and
   `git stash create` captures **post-reset** bytes — a ref that looks like a
   rescue and contains origin's content. **Reverted.** Pinned by a trap-guard
   test so nobody rebuilds it.

3. **`$?` after a pipeline.** Made me report `--all` as green when it had
   **68 offenders on pristine main**. I built advisory machinery to fix a
   non-existent regression, then deleted it.

4. **A function that compiled but could never run.** `sum(bigint)` returns
   `numeric`; plpgsql doesn't check `RETURN QUERY` shape until execution, so
   `CREATE FUNCTION` accepted it and **every call** raised a type error. Found by
   calling it. **Lesson: a migration that creates a function should call it.**

5. **My own gate blocked my own push** (Phase 4 rule vs Phase 5 migration) —
   `fn_prune_index_usage_snapshots` was an unauthenticated DELETE over the very
   evidence table. Working as designed.

6. **Append-only migrations vs negative assertions.** Twice I wrote tests
   asserting bad text was absent, which failed because history legitimately
   contains it. **Strip comments; assert on the final definition.**

7. **CI did not trigger** on one push. The PR head was my new commit but no run
   existed. Fixed with an empty commit. **Always check the run's `headSha`.**

8. **The shared clone was reset mid-session** and lost my Phase 1 edits (they
   were safe on `origin/main`). **Always work in your own worktree.**

---

## 16. Known Defects And Architectural Holes

| Priority | Defect                                                                   | Evidence                                                                                                                                                | Impact                                                                             | Recommended Fix                                                                                                       | Status                                                           |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **P1**   | Post-deploy E2E does not run                                             | Last 8 runs: 7 skipped, 1 failure; 30 specs exist                                                                                                       | **Nothing verifies production after publish**                                      | Phase 6                                                                                                               | Open                                                             |
| **P1**   | Stories silently empty for logged-in users                               | 1,310 `permission denied for table profiles`/hr; `fn_get_stories` is SECURITY INVOKER, client falls back to anon key while sending a real `p_viewer_id` | Feature broken; log noise                                                          | Use the Supabase client instead of hand-rolled token hunting in `World-Hub/src/components/social/Stories.jsx:295-320` | **Open, pre-existing, NOT a regression** (proven by time-series) |
| **P2**   | `fn_get_stories` is anon-executable with a caller-supplied `p_viewer_id` | Same class as the Phase 4 fix                                                                                                                           | Would leak private story feeds **if** anon is ever granted `username`/`avatar_url` | Revoke anon EXECUTE                                                                                                   | Open                                                             |
| **P2**   | 24 built pages reachable from nothing                                    | `everyRouteIsReachableLaw.test.ts` allowlist                                                                                                            | ~9,900 lines invisible (UnionDashboard 3,105; AgentDashboard 1,544)                | Phase 7 — **needs Dan's product calls**                                                                               | Open                                                             |
| **P2**   | 44 PRs with genuinely unshipped work                                     | `docs/audit/2026-08-31-pr-backlog-triage.md`                                                                                                            | Money-path fixes unshipped (#1742, #1105, #1053)                                   | Re-apply intent to current code — cannot merge, 800-1,100 behind                                                      | Open                                                             |
| **P2**   | Migration rollback never tested                                          | No rollback run this session                                                                                                                            | A bad migration has no proven path back                                            | Add rollback rehearsal                                                                                                | Open                                                             |
| **P3**   | `check-definer-authorization --all` fails with 68 offenders              | Verified on pristine `main`                                                                                                                             | Manual sweep unusable                                                              | Judge only the final declaration, or accept CI-mode-only                                                              | **Pre-existing**                                                 |
| **P3**   | 128 tables RLS-enabled with no policies                                  | Supabase advisor                                                                                                                                        | Fail-closed, so no leak; each is service-role-only or silently broken              | Classify once                                                                                                         | Open                                                             |
| **P3**   | 19 unindexed foreign keys; 47 tables with duplicate permissive policies  | Supabase advisor                                                                                                                                        | Perf                                                                               | After Phase 5 evidence lands                                                                                          | Open                                                             |
| **P3**   | No visual/responsive/a11y verification                                   | Never run                                                                                                                                               | 375px behaviour unproven                                                           | Add to Phase 6                                                                                                        | Open                                                             |
| **P4**   | OneSignal dead push path (#1498)                                         | Open issue                                                                                                                                              | Notifications go nowhere                                                           | Phase 8                                                                                                               | Open                                                             |
| **P4**   | Vestigial `club-arena` Vercel project (#997)                             | Open issue                                                                                                                                              | Duplicate-build risk                                                               | Phase 8                                                                                                               | Open                                                             |
| **P4**   | CLAUDE.md §1.1.5 + `.husky/pre-push` check 0 are stale                   | Contradict live API                                                                                                                                     | Misleads agents                                                                    | Correct both                                                                                                          | Open                                                             |

---

## 17. Security, Secrets, And Credentials

**No secret values are reproduced here, and none were printed during the session.**

| Name                            | Location                                              | Used by                           | Available                                 |
| ------------------------------- | ----------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`     | `~/Documents/club-arena/.env`, World Hub `.env.local` | `gen-schema-manifest.mjs`, engine | Yes (confirmed present, value never read) |
| `SUPABASE_URL`                  | same                                                  | Manifest + engine                 | Yes                                       |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | World Hub env                                         | Browser                           | Yes                                       |
| `SENTRY_AUTH_TOKEN/ORG/PROJECT` | `~/Documents/club-arena/.env`                         | Sync script                       | UNVERIFIED                                |
| `GH_PAT` / `gh` auth            | `gh` CLI keychain                                     | PRs, merges                       | Yes                                       |
| `CRON_SECRET`                   | Vercel + Open Claw                                    | Cron routes                       | UNVERIFIED                                |

**No credential exposure occurred.** Remote URLs were redacted when printed.
Some MCP servers (asana, atlassian, datadog, linear, notion, pagerduty, slack,
engineering:github) **require OAuth and are unavailable in a non-interactive
session** — authorize via claude.ai connector settings or `/mcp` if needed.

---

## 18. Database, Migration, And Seed Status

**Provider:** Supabase PostgreSQL 17.6, project `kuklfnapbkmacvwxktbh`.

**Migrations applied this session (via MCP `apply_migration`, the only sanctioned path):**

| Version          | Name                                          | Effect                                 | Verified      |
| ---------------- | --------------------------------------------- | -------------------------------------- | ------------- |
| `20260831110515` | `anon_cannot_name_itself_the_actor`           | Hardened identity; revoked PUBLIC+anon | Yes, by query |
| (P5 #1)          | `index_evidence_that_can_actually_accumulate` | Cross-epoch reader + prune fn          | Yes           |
| (P5 #2)          | `index_evidence_fix_sum_returns_numeric`      | bigint cast + cron cadence             | Yes           |
| (P5 #3)          | `prune_index_snapshots_is_not_a_browser_rpc`  | Revoked prune from browsers            | Yes           |

**Objects touched:** `fn_club_set_member_role` (replaced),
`fn_truly_unused_indexes` (replaced), `fn_prune_index_usage_snapshots` (new),
`index_usage_snapshots` (data only), `cron.job` 140 (rescheduled) + new prune job.

- **RLS:** unchanged this session.
- **Rollback:** **NOT TESTED.** No `DOWN` written. Both changes are
  `CREATE OR REPLACE` + `REVOKE`, so reversal means restoring the prior body
  (recoverable from the migration files) and re-granting.
- **Seeds:** none written; none run.
- **Local vs remote:** repo migrations are **intentionally stale** relative to
  production (schema is applied via MCP). The manifests are the source of truth
  for "does this object exist" — regenerate them in the same PR when adding one.
- **Backups:** no backup was taken before these changes. **UNVERIFIED** whether
  Supabase PITR is enabled.

---

## 19. Current Blockers And Decision Points

| Blocker               | Type                     | Options                                                              | Recommended                                                                                                                                     |
| --------------------- | ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **24 orphaned pages** | **Requires Dan**         | (a) connect each to a nav surface; (b) retire; (c) leave allowlisted | Present the list, get a per-page call. `/agent-management` looks like a plain bug — it renders RateAuditPage, which already owns `/rate-audit`. |
| **44 unshipped PRs**  | **Requires Dan**         | (a) re-apply intent to current code; (b) close as stale              | Money paths first (#1742, #1105, #1053)                                                                                                         |
| **E2E credentials**   | Technical + possibly Dan | Specs skip when signed out; need `SP_EMAIL`/`SP_PASS` in CI          | Confirm whether a test account may be used in CI                                                                                                |
| **Index drops**       | Time-blocked             | Evidence lands ~2026-09-07                                           | Wait. Do not drop before `fn_truly_unused_indexes(7)` returns rows                                                                              |
| **Stories bug**       | Technical, cross-repo    | Fix client token handling in World Hub                               | Not Club Arena's repo; coordinate                                                                                                               |

---

## 20. Remaining Work

### Critical

- **Phase 6:** make post-deploy E2E actually run, or stop counting it as a gate.
- Fix the Stories anon-fallback bug (World Hub) — a live user-facing failure.

### High Priority

- **Phase 7:** 24 orphaned pages — connect or retire (needs Dan).
- Revoke anon EXECUTE on `fn_get_stories`.
- Work the 44 unshipped PRs, money paths first.
- Test a migration rollback path.

### Medium Priority

- **Phase 8:** OneSignal (#1498), Vercel cleanup (#997), migration reconciliation.
- Classify the 128 RLS-no-policy tables.
- Fix stale CLAUDE.md §1.1.5 and `.husky/pre-push` check 0.
- Add 19 missing FK indexes; dedupe 47 permissive-policy tables.

### Low Priority

- Make `check-definer-authorization --all` usable (68 historical offenders).
- Visual/responsive/a11y verification at 375px.

### Optional

- Bundle-size budget; index drops once evidence matures (~2026-09-07).

---

## 21. Prioritized Next-Phase Execution Plan

### Phase 0 — Recover and verify current state (do this first, ~10 min)

**Objective:** confirm this document still matches reality.
**Steps:** §22 checklist. **Completion:** you can state current `origin/main`,
that your worktree is clean, and that the four production assertions in §10 hold.
**Risk:** the repo moved 38 commits during one session; assume drift.

### Phase 1 — Protect completed work

Do **not** revert, commit, or clean the 9 dirty files in the shared clone. Create
your own worktree. Confirm the 5 law tests still pass — they are the guardrails
for everything above.

### Phase 6 (the actual next phase) — E2E honesty

**Objective:** post-deploy E2E either verifies production or stops claiming to.
**Inspect:** `.github/workflows/post-deploy-e2e.yml`, `tests/e2e/*.spec.ts` (30),
`tests/e2e/global-setup.ts`.
**Known:** many specs call `test.skip()` when signed out or when no live
tournament exists — the suite can pass by not running. Last 8 runs: 7 skipped,
1 failure.
**Changes:** decide the credential story; make skips visible (a run that skips
everything should not report success); fix the one real failure.
**Tests:** at least one spec must fail if production is broken — prove it by
pointing a spec at a deliberately wrong assertion once.
**Completion:** a post-deploy run that either genuinely exercises production or
reports honestly that it did not.
**Risk:** adding credentials to CI is a security decision — ask Dan.
**Checkpoint:** one PR, `fix(e2e): ...`.

### Phase 7 — Orphan pages

**Prereq:** Dan's per-page decision. Each page connected or retired **deletes a
line from `ALLOWED_ORPHANS`** and the ratchet keeps the number from rising.
**Completion:** allowlist ORPHANED count < 24 and the ceiling assertion lowered.

### Phase 8 — Small closables

#1498 OneSignal, #997 Vercel, migration reconciliation.

---

## 22. Exact First Actions For The Next Agent

```text
1.  cd /Users/smarter.poker/Documents/club-arena
2.  Read: AGENT-PLAYBOOK.md, then CLAUDE.md, then
    .agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md
3.  git fetch origin main
    git status --porcelain          # expect other-agent dirt; DO NOT clean it
    git rev-parse --short origin/main
4.  Create your own worktree (never work in the shared clone):
      AGENT_REF_GUARD_OK=1 git worktree add \
        ~/Documents/.agent-trees/club-arena/<your-name> -b <branch> origin/main
      cd ~/Documents/.agent-trees/club-arena/<your-name>
      ln -sfn ~/Documents/club-arena/node_modules node_modules   # REQUIRED
5.  Confirm the guardrails still pass:
      npx vitest run tests/unit/hamburgerMenuLaw.test.ts \
        tests/unit/navigationSurfacesLaw.test.ts \
        tests/unit/everyRouteIsReachableLaw.test.ts \
        tests/unit/resetGuardCannotSaveTheWorktree.test.ts \
        tests/unit/indexEvidenceCanAccumulate.test.ts \
        tests/anon-cannot-name-itself-the-actor.test.ts
      npx tsc --noEmit
6.  DO NOT MODIFY: the 9 dirty files in the shared clone (§10);
    supabase/migrations history; other agents' .agent/handoffs/*.
7.  RESUME AT: Phase 8 of 8 — the small closables (§21). Phases 6 and 7 both
    completed 2026-08-31 (PRs #2184, #2201, #2237, #2265); see the notes at the
    top of this file.
```

---

## 23. Acceptance Criteria

**Phase 6 is done when:** a post-deploy E2E run either genuinely exercises
production against a real session, or reports unambiguously that it did not; a
run in which every spec skips cannot report success; the one failing spec is
fixed or removed with a reason; and the behaviour is pinned by a test or a gate.

**The overall 8-phase effort is done when:**

- Functional: every menu destination resolves, and every route is reachable or
  explicitly justified (allowlist ORPHANED count → 0 or Dan-approved).
- Data/financial: no anon-callable definer writer with a spoofable actor (**met**);
  index drops made only on ≥7 days of accumulated evidence.
- Testing: full suite green; post-deploy E2E meaningful; every new rule pinned by
  a test proven red in its failure direction.
- Migration safety: repo↔production manifests agree; rollback rehearsed.
- Git: `main` clean, no unmerged agent work, backlog triaged.
- Deployment: `/api/health` serves the expected SHA and the deployed bundle is
  grepped for the change — repo state alone is never proof.

---

## 24. Recommended Commit Strategy

| Commit                                                    | Contents                                  | Tests required first              |
| --------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| `fix(e2e): make the post-deploy run report honestly`      | workflow + global-setup                   | Targeted e2e run; full unit suite |
| `fix(e2e): repair the one genuinely failing spec`         | that spec only                            | That spec, proven red then green  |
| `fix(security): fn_get_stories must not be anon-callable` | migration + test                          | Definer gate + new test           |
| `feat(nav): connect <page>` (one per page)                | route + registry + allowlist line removed | `everyRouteIsReachableLaw`        |
| `chore(cleanup): retire <page>`                           | route + component removal                 | Full unit suite                   |

Never mix a migration with unrelated UI work — CI classifies by changed path.

---

## 25. Final Continuation Summary

**Stopping point:** Phases 1-5 of 8 are complete, merged (PRs #2006, #2032,
#2069, #2087, #2099, #2111, #2116, #2130, #2149) and verified in production.
Phase 6 has not been started. My worktrees are removed; nothing of mine is
uncommitted.

**Work on first:** Phase 6 — post-deploy E2E currently verifies nothing.

**Most important locked requirements:** ticker only at `/table/*`; Title Case at
source on every nav label; horses are players; never push a red test; never probe
a money or privilege path against production.

**Greatest technical risk:** the 44 PRs of unshipped work are 800-1,100 commits
behind and cannot be merged — their intent must be re-applied by hand, and every
day makes that harder.

**Greatest visual risk:** none introduced. No UI rendering was verified at any
viewport this session; the nav changes were proven by bundle grep, not by looking
at a screen.

**Greatest data-integrity risk:** dropping indexes before ~2026-09-07. The
advisor's 1,129 "unused" figure reflects ten hours of statistics on a nightly-
restarting server. `fn_truly_unused_indexes(7)` returning 0 is the mechanism
working, not a failure.

**Still requires Dan:** the 24 orphaned pages (connect vs retire), the 44 PRs
(re-apply vs close), and whether test credentials may live in CI.

**How to continue without restarting discovery:** everything measured is written
down — the deploy pipeline, the two shipping paths and the residue they create,
the statistics environment and why `idx_scan` lies, the column-level grants on
`profiles`, and each gate's real coverage versus its documented promise. Run the
§22 checklist, read the three audits in `docs/audit/`, and begin at Phase 6. The
five law tests are your regression net: if they pass, phases 1-5 are intact.

---

## 26. Phase 6 Addendum (2026-08-31, incoming agent)

**Phase 6 of 8 — E2E honesty — is COMPLETE.** PRs #2184 and #2201, both merged,
both verified against production.

The post-deploy run could report success four ways without verifying anything:
skips were never counted (Playwright exits 0 when everything skips); the
signed-out fallback in `global-setup.ts` was silent; a failed Cashier step
**skipped** the entire broader sweep despite its own comment promising the
opposite; and inside that sweep `set -e` let a red Stats invocation abort the
route invocation behind it.

The "one genuine failure" named in §16 was **not a defect**. The workflow
correctly stopped pinning to a sha, but the CHECKOUT never followed, so it tested
the bundle players had using assertions from a newer commit. That is now
reconciled: assertions come from the deployed commit when it is an ancestor, and
the drift is reported loudly when it is not. The harness (`global-setup.ts`,
`support/`) deliberately stays at HEAD — swapping it wholesale would have
restored the signed-out fallback on exactly the runs the fix was written for.

**New guardrail:** `tests/unit/postDeployE2eHonestyLaw.test.ts` (17 tests) joins
the five law tests in §3 as the regression net. `scripts/ci/e2e-may-skip-entirely.json`
is a ratchet and ships **empty** — the first measured run had all 23 spec files
executing something.

**First real verdict** (run `33398218482`): 148 executed, 4 skipped, 3 failed,
1 flaky, 23 spec files. `routes/hamburger-menu.spec.ts` executed 33 tests against
production — Phases 1 and 2 verified on the live site for the first time.

**Still open, and now measured:** the PGRST002/503 storms above. Someone needs to
own that. It is the single loudest thing in production right now.

---

## 27. Phase 7 Addendum (2026-08-31)

**Phase 7 of 8 — the orphaned pages — is COMPLETE.** PR #2265, merged.

**The count in §16 was wrong, and that is the main thing to carry forward.** The
ratchet counts ROUTES; the sentence that travelled through two handoffs described
PAGES. Of the 24:

- **12 were legacy redirects** with no page at all - four through
  `LegacyClubToolRedirect`, four to the World Hub messenger, three plain
  `<Navigate>`, and `notification-center`, which Dan retired on 2026-08-25.
  Being unreachable from navigation is the POINT of a legacy redirect. One
  reason was not merely vague but false: `agent-management` was recorded as
  rendering `RateAuditPage`, which it had not done for some time.
- **3 were a second door** onto a component already reachable elsewhere.
- **9 were real pages.** About 6,300 lines, not 9,900.

**Two production numbers decided most of it.** `agent_commissions` holds
**1,490,109 rows** against 113 agents with no door anywhere, and `user_reports`
holds **zero** - never once - while the review page that reads it has always been
reachable. The club had a moderation queue that could not receive anything.

**Connected:** `agent-dashboard` (hamburger, Club Operations),
`clubs/:clubId/agent-dashboard` (operations rail, "Agent Network"),
`clubs/:clubId/anti-cheat` (new route, operations rail, "Anti-Cheat"), and
`report/:playerId` (Report action on the public profile, beside Block).

**Retired as redirects, nothing deleted:** `rakeback-dashboard`,
`player-sessions`, `waitlist`, `union-dashboard`, `union-games`,
`clubs/:clubId/dashboard`.

**Still open and needing Dan:** `xmtt` (XMTTPage, 551 lines) and `flash-pool`
(FlashPoolPage, 450 lines). Both built, both player-facing game modes, parked as
a launch decision rather than a wiring one.

**A pattern worth carrying into Phase 8:** every connection here was proven by
BREAKING it - removing the nav entry and watching `everyRouteIsReachableLaw` go
red naming the route that lost its door. A page is only connected if the ratchet
can tell when it stops being connected.
