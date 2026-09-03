# CONTINUATION HANDOFF - Club Operations Workspace Upgrade (Dan's 8-phase programme)

**Author:** Cowork agent session `session_017c7nuqQjkMLnhVFPByyE2e`
**Written:** 2026-09-03 ~21:55 UTC
**Branch:** `feat/club-operations-full-upgrade`
**HEAD at time of writing:** `8f906f778`
**Companion map:** `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md` (full 26-route inventory, all 8 phases, every confirmed defect)

> **DO NOT CONFUSE THIS WITH `docs/HANDOFF_CURRENT_STATE.md`.** That file belongs to a
> different, concurrent programme (the Engine-Restart & Platform-Hardening work, authored by
> the `cowork-maintbreak` session). It was last touched by commit `c083b3aa7`. Do not edit,
> overwrite, or "update" it as part of this work.

---

## 1. Executive Continuation Brief

### What is being built

Club Arena is the club-operator product inside Smarter Poker: a Vite + React 19 + TypeScript
SPA served at `https://smarter.poker/hub/club-arena/`, backed by Supabase Postgres and a
separate realtime poker engine on Hetzner. This programme upgrades the **Club Operations
workspace** - the operator back office at
`https://smarter.poker/hub/club-arena/clubs/<club-slug>/operations` and every one of its
26 sub-routes.

### The business objective, in Dan's framing

Every page in that workspace must be _fully built out, wired in, and 100% working, with no
bugs, gaps, stubs, errors, regressions or wiring issues, anywhere_. The recurring theme the
work has actually uncovered is worse than "unfinished": **operator controls that report
success and write nothing**, and **numbers presented as records that were arithmetic**. An
operator has been making decisions this software silently discarded.

### Current phase

**Phases 1, 2 and 3 of 8 are built, tested, committed and pushed.** Phase 3 (the agent
network) was completed in the final stretch of this session.

### The immediate unfinished objective

**RESOLVED AT 22:05 UTC, AFTER THE BODY OF THIS DOCUMENT WAS DRAFTED.** CI went green on
`8f906f778`, autopilot squash-merged PR #2853 as **`c22a3bb00`** on `main`, and the publisher
shipped it. `c22a3bb00` is a verified ancestor of the live
`ca_sha = 71b310c016a92ece98ca484dc3e8ec46ec9f84a8`. **Phases 1, 2 and 3 are merged and in
production.**

Two earlier CI runs on this branch failed on **flaky tests in server-engine code this work never
touched** (`CryptoRandom.test.ts`, `InsuranceRitExclusivity.test.ts`). They passed on the third
run with no change made. Those flakes are still latent - see I-01 and I-02.

**So the immediate unfinished objective is no longer the merge.** It is:

1. The manual browser pass that has never been done (D-05), now possible because the work is live.
2. **Phase 4 of 8, the club dashboard**, starting with the standing CLAUDE.md 10.5 violation
   (P-01, the "Humans Only" filter that strips 416 of 417 players out of a total).

### The single most important thing the next agent must understand

> **The verification method is what makes this work valuable, and it must not be skipped.**
> Write the missing test, then **probe the live database as the real user inside a transaction
> that is rolled back** (`set_config('request.jwt.claims', ...)` + `SET LOCAL ROLE
authenticated` + `ROLLBACK`). That method has found a real defect in _every single phase,
> including in this agent's own freshly written code_ - four in Phase 1, two in Phase 2, and in
> Phase 3 it caught a function that would have **destroyed 10,067.64 chips** belonging to the
> first member it touched. `tsc` passing and gates passing did not catch any of them.

### The first action the next agent should take

Run the Phase 0 checklist in section 22. In short: confirm the branch is still clean at or
ahead of `8f906f778`, check whether PR #2853 has merged and published, and **do not start
Phase 4 until you know whether the branch is green**.

---

## 2. User Requirements And Working Preferences

### The original directive (Dan, verbatim intent, first message of the session)

> "THE CLUB OPERATIONS OVERVIEW PAGE, AND SUB PAGES NEEDS A FULL UPGRADE AND ENHANCEMENT
> https://smarter.poker/hub/club-arena/clubs/deep-stack-society-11192/operations AND ALL OF
> ITS SUB PAGES... YOU NEED TO GO THROUGH THEM ALL ONE PAGE AT A TIME, AND VERIFY AUDIT AND
> UPGRADE EVERY SINGLE PAGE. YOU NEED TO MAKE SURE THEY ARE ALL FULLY BUILT OUT, WIRED IN AND
> 100% FULLY WORKING WITH NO BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE
> AND EVERYWHERE... THEN TAKE EVERY SINGLE THING YOU JUST SAID NEEDED TO BE DONE AND BREAK
> THIS DOWN INTO PHASES AND LET ME KNOW IN THE SUMMARY PHASE 1 OF X IS DONE, WITH THE SUMMARY,
> FOLLOWED BY READY TO START PHASE 2 OF X. GO AHEAD AND FULLY BUILD ALL OF THEM OUT, ONE PHASE
> AT A TIME. AND MAKE SURE THEY ARE FULLY BUILT OUT, CODED, WIRED IN AND TESTED BEFORE CLAIMING
> SUCCESS. YOU CAN DECIDE THE BUILD ORDER."

**NON-NEGOTIABLE, treat as standing:**

1. **One phase at a time.** Report "Phase N of 8 is done" with a summary, then "ready to start
   Phase N+1".
2. **Per-phase verification gate**, stated by Dan twice, verbatim:
   > "before you move onto to phase N of 8, you need to do a deep dive and verify that every
   > thing you've built in the previous phase is 100% fully built, coded, wired in and tested.
   > CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND
   > EVERYWHERE. Make sure that everything has been fully pushed and published before moving
   > onto the the next phase."
3. **Do not claim success without verification.** Dan: _"do not claim success until you have
   verified that everything is 100% accomplished for this task."_
4. **Everything gets pushed.** Dan, late in the session: _"MAKE SURE ANYTHING AND EVERYTHING
   YOU HAVE PENDING OR UNPUBLISHED GETS PUSHED OR PUBLISHED NOW."_
5. **The agent chooses the build order.** Dan explicitly delegated this.

### Deployment instruction - CONFLICTING SOURCES, RESOLVED

Dan gave two statements that appear to contradict each other. **They do not conflict in
practice**, and the next agent must not "fix" one to match the other:

- **Mid-session:** _"we are not pushing and publishing club arena stuff directly to hetzner.
  make sure you are following the new routes, and not the old legacy routes."_
- **Late session:** _"WE HAVE CHANGED HOW THINGS ARE PUSHED AND PUBLISHED, CLUB ARENA NOW USES
  HETZNER TO PUBLISH DIRECTLY. REVIEW THE .MD AND .ENV FOR ALL NEW PUSH PATHS."_

**Resolution (verified against `origin/main`):** `.agent/architecture/deploy-paths.md`, rewritten
on main 2026-09-03, says Tier 2 (the Vite frontend) publishes to `ca-static.smarter.poker` -
**Caddy on the Hetzner box `estate-ci-1` at `/srv/club-arena/`**. So Club Arena _does_ now
publish to Hetzner, and the retired path (committing `dist/` into the World Hub's
`public/hub/club-arena/`) is gone. **The agent's job is identical under both statements:
push a branch and stop.** The doc is explicit that the origin layout is _"written by the
publisher, never by hand."_

**AGENTS MUST NEVER:** rsync, SSH, or otherwise touch Hetzner; deploy to Vercel; commit into
the World Hub repo; or run a sync script.

### Binding house rules that shaped every line of this work

Sourced from `CLAUDE.md` (1,071 lines) and `docs/LAWS.md`:

| Rule                                                   | Where                                            | What it means here                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Horses are players**                                 | CLAUDE.md Section 10.5, BINDING, "NO EXCEPTIONS" | Never filter house-run AI accounts out of any count, report, export or payout. A `is_horse` filter in a total is a violation. Gated by `scripts/ci/check-horses-are-players.mjs`. |
| **Never close a `table_seats` row outside a cash-out** | CLAUDE.md Section 11.5                           | Doing so destroys the stack sitting in the seat. Removal from a live table is the **engine's** job (`POST /admin/kick`).                                                          |
| **Never spend real chips to test**                     | CLAUDE.md Section 11.5                           | Probe inside a rolled-back transaction.                                                                                                                                           |
| **No em dashes (U+2014) in UI copy**                   | CLAUDE.md Section 10.7                           | Gated by `check-ui-text`. Note the rule is about em _dashes_, not the word "bars".                                                                                                |
| **Title Case on every painted word**                   | -                                                | Gated by `check-title-case`, `check-nav-title-case`, `check-painted-text-case`.                                                                                                   |
| **No emoji in source**                                 | -                                                | Gated by `check-no-emoji`. Several controls in this codebase are _empty wrappers_ left behind when emoji were stripped - see Defects.                                             |
| **No `:hover` anywhere**                               | `tests/no-hover-effects.law.test.ts`             | Use `:focus-visible`. This is a repo law test; it will go red.                                                                                                                    |
| **No byte-counted source windows in tests**            | `tests/unit/noFixedSizeSourceWindows.test.ts`    | Use `sliceSqlStatement` from `tests/helpers/sourceWindow`. Never `body.slice(0, 800)`.                                                                                            |
| **`.maybeSingle()`, never `.single()`**                | -                                                | Gated by `check-maybe-single`.                                                                                                                                                    |
| **`toLocaleString` / `fmt` on numbers**                | -                                                | Not gated; enforced by review.                                                                                                                                                    |
| **Mobile-first at 375px**                              | -                                                | Not gated; enforced by review.                                                                                                                                                    |
| **Never rebase main**                                  | CLAUDE.md                                        | Use `git merge origin/main`.                                                                                                                                                      |
| **One migration = one transaction**                    | CLAUDE.md Section 2 (production DDL policy)      | Consequence: `CREATE INDEX CONCURRENTLY` is unavailable.                                                                                                                          |
| **Write a changelog**                                  | -                                                | `docs/changelog/YYYY-MM-DD-<slug>.md` per shipped commit.                                                                                                                         |
| **Never push a red test**                              | CLAUDE.md Section 10.8                           | -                                                                                                                                                                                 |
| **Never sit watching CI**                              | CLAUDE.md Section 10.8-3                         | Push and move on.                                                                                                                                                                 |

### Working preferences observed

- Dan writes in **all caps** when the instruction is binding. Treat those as law.
- Dan wants **numbers, not adjectives**. Every claim in the commit messages and changelogs
  carries the measured figure that proves it.
- Dan corrected the agent **twice** on the deploy route, so it is clearly a sore point.
  Re-read `.agent/architecture/deploy-paths.md` on `origin/main` before assuming anything.
- Commit messages and changelogs in this repo are written in **prose, in a distinctive
  house voice** - stating what was wrong, with evidence, before what changed. Match it.

### Things NOT specified by Dan

- **UNKNOWN:** No visual/design references, mockups, or locked reference images were provided
  at any point in this session. Section 8 (Visual And Product Decisions) is therefore largely
  N/A - see that section.
- No specific deadline, no priority ordering among phases 4-8 beyond the agent's own choice.

---

## 3. Project And Repository Identity

| Field                           | Value                                                                          | Confidence                                                         |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Project Name                    | Club Arena (Smarter Poker)                                                     | CONFIRMED                                                          |
| Repository                      | `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git` (private)          | CONFIRMED via `git remote -v`                                      |
| Repository Root (this worktree) | `/Users/smarter.poker/Documents/.agent-trees/club-arena/ops-upgrade`           | CONFIRMED via `git rev-parse --show-toplevel`                      |
| Current Working Directory       | same as above                                                                  | CONFIRMED                                                          |
| Git dir (it is a **worktree**)  | `/Users/smarter.poker/Documents/club-arena/.git/worktrees/ops-upgrade`         | CONFIRMED                                                          |
| Main clone (holds `.env`)       | `/Users/smarter.poker/Documents/club-arena`                                    | CONFIRMED                                                          |
| Current Branch                  | `feat/club-operations-full-upgrade`                                            | CONFIRMED                                                          |
| Remote name                     | `origin` (only remote)                                                         | CONFIRMED                                                          |
| Primary Framework               | Vite + React 19 + TypeScript, React Router v7, CSS Modules                     | CONFIRMED                                                          |
| Vite `base`                     | `/hub/club-arena/`                                                             | CONFIRMED (stated in prior context; re-verify in `vite.config.ts`) |
| Package Manager                 | npm (`package-lock.json` present; no yarn/pnpm lock)                           | CONFIRMED                                                          |
| Runtime on this machine         | node v26.3.0, npm 11.16.0                                                      | CONFIRMED                                                          |
| Test runner                     | vitest v4.0.18                                                                 | CONFIRMED                                                          |
| Database                        | Supabase Postgres, project ref `kuklfnapbkmacvwxktbh`                          | CONFIRMED                                                          |
| Frontend hosting                | `ca-static.smarter.poker` - Caddy on Hetzner `estate-ci-1`, `/srv/club-arena/` | CONFIRMED via `.agent/architecture/deploy-paths.md` on main        |
| Game engine hosting             | Hetzner CPX11 `ash-dc1`, `178.156.160.206`, `engine.smarter.poker`             | CONFIRMED via same doc; **out of scope for this work**             |
| Ops REST API                    | `Smarter-Poker-World-Hub` repo -> Vercel project `hub-vanguard`                | CONFIRMED via same doc; **different repo, out of scope**           |
| Vercel                          | **none for Tier 2.** `vercel.json` has `git.deploymentEnabled: false`          | CONFIRMED via deploy-paths.md                                      |
| CI                              | GitHub Actions on self-hosted runners (`estate-ci-*`)                          | CONFIRMED from run logs                                            |

### The reference club used throughout

- **Deep Stack Society**, slug `deep-stack-society-11192`, uuid
  `2a1132b9-5ba2-42e6-9f01-30a7fcffebe3`, owner uuid `47965354-0e56-43ef-931c-ddaab82af765`.
- CONFIRMED by live query. All figures in this handoff and in the commit messages were
  measured against this club unless stated otherwise.

---

## 4. Repository Map

Only paths relevant to continuation. **Modified** means changed by this session.

### Instruction and governance files - READ BEFORE EDITING ANYTHING

| Path                                                                  | Contents                                                                                                                                                                                                                                                         | Modified |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `CLAUDE.md` (1,071 lines)                                             | The binding agent instructions. Section 1.1 deploy pipeline, Section 2 production DDL policy, Section 10.5 horses, Section 10.7 em dashes, Section 10.8 laws + never wait on CI, Section 10.9 "you decide the money", Section 11 agent network + deploy playbook | No       |
| `AGENT-PLAYBOOK.md`                                                   | "START HERE" entry point referenced from CLAUDE.md Section 22                                                                                                                                                                                                    | No       |
| `AGENTS-PUSH-GUIDE.md`                                                | Push route guide; rewritten on main 2026-09-03 (`6f0435232`)                                                                                                                                                                                                     | No       |
| `.agent/architecture/deploy-paths.md`                                 | **The current deploy truth.** Three-tier architecture; Tier 2 -> Hetzner Caddy                                                                                                                                                                                   | No       |
| `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` | Architecture reference                                                                                                                                                                                                                                           | No       |
| `.agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md`                 | **Money ledger canon - read before any money work**                                                                                                                                                                                                              | No       |
| `.agent/AGENT-OPERATIONS-GUIDE.md`                                    | Operations guide                                                                                                                                                                                                                                                 | No       |
| `.agent/protected-commits.json`                                       | Commits that must not be reverted                                                                                                                                                                                                                                | No       |
| `docs/LAWS.md`                                                        | The law registry, enforced by `tests/law-registry.law.test.ts`                                                                                                                                                                                                   | No       |
| `docs/HANDOFF_CURRENT_STATE.md`                                       | **OTHER PROGRAMME. DO NOT TOUCH.** Engine-restart handoff                                                                                                                                                                                                        | No       |

### This programme's own documents

| Path                                                                                         | Contents                                                                                                                                                   | Modified                         |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md` (550 lines)                                | **THE MAP.** Full 26-route inventory, build order, all 8 phases, every CONFIRMED defect with file:line evidence. Phases 1-3 marked DONE with what shipped. | **YES - created and updated 4x** |
| `docs/changelog/2026-09-03-club-operations-phase-1-the-shell.md`                             | Phase 1 + its verification pass                                                                                                                            | **YES - created**                |
| `docs/changelog/2026-09-03-club-operations-phase-2-an-integrity-decision-is-written-down.md` | Phase 2 + the collusion correction                                                                                                                         | **YES - created**                |
| `docs/changelog/2026-09-03-club-operations-phase-3-the-agent-network.md`                     | Phase 3                                                                                                                                                    | **YES - created**                |
| `docs/HANDOFF-2026-09-03-club-operations-upgrade.md`                                         | **THIS FILE**                                                                                                                                              | **YES - created**                |

### Production source - modified by this work

| Path                                                             | What it is                                                                                                                                                                                                                                                     | Edit freely?                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/config/clubOperationsNavigation.ts`                         | **The registry.** Single source of truth for which operator tools exist, their routes, required access level, group, art, and `signals` (which overview counts badge them). `OPERATION_SUFFIXES` / `CONTROL_SUFFIXES` drive `ClubCapabilityGuard`.             | Yes, but a law test fails if a definition is added without its suffix |
| `src/hooks/useClubOperationsOverview.ts`                         | Shared, deduped reader for `ca_club_operations_overview`. Module-level `inflight`/`shared` maps, `SHARE_MS = 15_000`, `resetClubOperationsOverviewCache()` for tests. `load({silent, force})` - the two flags are independent and that matters (see Setbacks). | Yes                                                                   |
| `src/components/navigation/ClubOperationsRail.tsx`               | **Entry-chunk half.** Route check + staff check only. **Must never import anything that queries** - see the entry-chunk regression in Setbacks.                                                                                                                | Yes, carefully                                                        |
| `src/components/navigation/ClubOperationsRailBody.tsx`           | **Lazy half.** All the reading and rendering.                                                                                                                                                                                                                  | Yes                                                                   |
| `src/components/navigation/ClubOperationsRail.module.css`        | Shared by both halves                                                                                                                                                                                                                                          | Yes                                                                   |
| `src/pages/club/ClubOperationsPage.tsx` (+ `.module.css`)        | The `/operations` overview page. Live reading strip, "Waiting For You" alerts deep-linked by registry tool id, per-tool and per-group badges, skeletons, freshness line. Exports `ago()` and `freshnessLabel()`.                                               | Yes                                                                   |
| `src/pages/workspaces/ArenaWorkspacePages.tsx` (+ `.module.css`) | `/finance` and `/control` sub-workspaces. `useClubWorkspaceGroup(group)` returns `{links, alerts, overview}`.                                                                                                                                                  | Yes                                                                   |
| `src/pages/AntiCheatPage.tsx` (+ `.module.css`)                  | 5-tab integrity console. Exports `evidenceSummary()`.                                                                                                                                                                                                          | Yes                                                                   |
| `src/pages/ReportReviewPage.tsx` (+ `.css`)                      | Moderation queue. `REPORT_POLL_MS = 45_000`, `REPORT_PAGE_SIZE = 100`.                                                                                                                                                                                         | Yes                                                                   |
| `src/pages/BlacklistManagerPage.tsx` (+ `.module.css`)           | Exclusion ledger with roster picker                                                                                                                                                                                                                            | Yes                                                                   |
| `src/pages/AgentManagementPage.tsx` (+ `.module.css`)            | The agent network console (Agents / Players / Hierarchy / Credit Limits / Commissions / Payouts tabs)                                                                                                                                                          | Yes                                                                   |
| `src/pages/AgentDashboardPage.tsx`                               | An individual agent's dashboard, incl. the credit and transfer panels                                                                                                                                                                                          | Yes                                                                   |
| `src/pages/SuperAgentDashboard.tsx`                              | Super agent's view of their downline                                                                                                                                                                                                                           | Yes                                                                   |
| `src/services/AgentService.ts`                                   | Agent CRUD, downline, wallet sends, claim-back                                                                                                                                                                                                                 | Yes                                                                   |
| `src/services/CreditService.ts`                                  | Credit lines. **Object literal, not a class - methods are comma-separated.**                                                                                                                                                                                   | Yes                                                                   |
| `src/services/DisputeService.ts`                                 | Dispute transitions                                                                                                                                                                                                                                            | Yes                                                                   |
| `src/services/IntegrityActionService.ts`                         | **Created this session.** `adminRemovePlayerFromClubTables(tableIds, userId, reason)` posts to the engine's `/admin/kick`; `liveSeatTableIds(clubUUID, userId)` finds live seats.                                                                              | Yes                                                                   |

### Production source - relevant but NOT modified

| Path                                           | Why it matters                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/layouts/AppLayout.tsx`         | Line ~113 mounts `<ClubOperationsRail />` on every page with a global header. **This is why the entry-chunk regression happened.**                          |
| `src/components/auth/ClubCapabilityGuard.tsx`  | Route-level permission guard, driven by the registry                                                                                                        |
| `src/components/wallet/WalletCashierModal.tsx` | **The correct reference implementation** for agent wallet sends and claim-backs. Phase 3 pointed the agent console at the same RPCs this file already used. |
| `src/components/agent/ChipTransferModal.tsx`   | Matches recipients against `club_members` -> `users.id`; this is why the transfer id bug mattered                                                           |
| `src/utils/clubIdResolver.ts`                  | `resolveClubUUID()`, `isUUID()`. Route params may be a uuid, a 6-digit code, **or a slug** - this is the single most common bug source in this codebase     |
| `src/utils/format.ts`                          | `fmt`, `fmtChips`, `timeAgo`                                                                                                                                |
| `src/utils/clubDashboard.ts`                   | `formatInt`, `isAuthzError`                                                                                                                                 |
| `src/lib/supabase.ts`                          | The client                                                                                                                                                  |
| `src/core/MasterBus.ts`                        | Cross-component event bus; gated by `check-bus-wiring`                                                                                                      |

### CI, gates and baselines

| Path                                                   | Purpose                                                                                                                                                      | Modified                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `scripts/ci/all-gates.sh`                              | The main gate runner: tsc, 14 house-rule gates, full vitest (~12,400 tests), vite build, bundle-size                                                         | No                            |
| `scripts/ci/entry-chunk-delta.mjs`                     | **NOT part of all-gates.sh.** Asks "who just started paying" for first paint. Compares the entry chunk's sourcemap module list against a committed baseline. | No                            |
| `scripts/ci/entry-chunk-baseline.json`                 | That baseline                                                                                                                                                | **YES - one module removed**  |
| `scripts/ci/schema-manifest.d/cowork-ops-upgrade.json` | Declares the 10 functions this branch owns, for `check-definer-authorization`                                                                                | **YES - created, updated 2x** |
| `scripts/ci/check-*.mjs` (13 DB/CI gates)              | See section 13 for the full list                                                                                                                             | No                            |

### Migrations added

All under `supabase/migrations/`. All five are applied to production **and** recorded.

| File                                                               | Purpose                                   |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `20260903160000_the_operations_page_reads_the_club_it_governs.sql` | Phase 1: `ca_club_operations_overview`    |
| `20260903170000_an_integrity_decision_is_written_down.sql`         | Phase 2: the integrity gate + 7 functions |
| `20260903180000_a_cleared_pair_stays_cleared.sql`                  | Phase 2 correction: collusion screen      |
| `20260903200000_an_agent_payout_is_a_record.sql`                   | Phase 3: agent gate, payables, ban        |
| `20260903210000_the_payables_read_is_index_only.sql`               | Phase 3: covering index                   |

### Tests added

| File                                                  | Runtime cases (measured)                             |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `tests/unit/clubOperationsRegistryIntegrity.test.ts`  | 108                                                  |
| `tests/unit/clubOperationsOverviewContract.test.ts`   | 54                                                   |
| `tests/components/club-operations-page.test.tsx`      | 14                                                   |
| `tests/components/club-operations-surfaces.test.tsx`  | 10                                                   |
| `tests/unit/integrityDecisionsAreWrittenDown.test.ts` | 44                                                   |
| `tests/components/anti-cheat-console.test.tsx`        | 11                                                   |
| `tests/unit/theAgentNetworkReachesSomething.test.ts`  | 32                                                   |
| **Total new**                                         | **273, all passing** (verified 2026-09-03 21:50 UTC) |

### Tests modified (pre-existing, changed deliberately)

- `tests/config/clubArenaAccessibilityFoundation.test.ts` - twice
- `tests/unit/discardedErrorReadRatchet.test.ts` - baseline lowered

---

## 5. Applicable Instructions And Constraints

**Reread these before editing.** Listed in the order they should be read.

1. `CLAUDE.md` - **the whole file**, but especially:
   - Section 1.1 "How your work reaches production (rewritten 2026-09-03)"
   - Section 1.3 "Never Do"
   - Section 1.4 "Claiming Success"
   - Section 2 "Production DDL policy (BINDING)" - added after a PGRST002 503 outage
   - Section 10 "Working rules (set by Dan, binding)"
   - Section 10.5 "Horses are players - NO EXCEPTIONS"
   - Section 10.7 "Em bars means em dashes"
   - Section 10.8 "Laws live in docs/LAWS.md, and you never wait on CI"
   - Section 10.9 "You decide the money" - defines when a money path is CLEAR (five conditions)
   - Section 11 / Section 11.5 - agent network + the seat-closing prohibition
2. `AGENT-PLAYBOOK.md` - the entry point CLAUDE.md Section 22 points at
3. `.agent/architecture/deploy-paths.md` - **the current deploy truth**
4. `.agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md` - before any money work
5. `docs/LAWS.md` - the law registry
6. `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md` - this programme's map

### Ambiguities and conflicts found

| Conflict                                                     | Resolution used                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dan's two statements about Hetzner                           | Both are satisfied by "push a branch and stop". See Section 2.                                                                                                                                                                                                    |
| `CLAUDE.md` line 3 points at `docs/HANDOFF_CURRENT_STATE.md` | That is the **engine-restart** programme's handoff, not this one. This handoff lives at `docs/HANDOFF-2026-09-03-club-operations-upgrade.md`.                                                                                                                     |
| Migration file version vs recorded version                   | `20260903160000_...sql` is recorded in `supabase_migrations.schema_migrations` under version **`20260903152100`** with the matching name. The `check-applied-migrations-are-recorded` gate passes (it evidently matches by name). **FLAGGED - see Defects D-09.** |

---

## 6. Complete Discovery Record

This section preserves the technical discovery so the next agent does not repeat it.

### 6.1 The workspace's architecture

- **The registry pattern.** `src/config/clubOperationsNavigation.ts` holds two lists that had
  silently drifted apart: `DEFINITIONS` (what the workspace _advertises_) and
  `OPERATION_SUFFIXES` (what `ClubCapabilityGuard` and the rail _recognise_). A tool present in
  the first but absent from the second gets **no capability check at all** and makes the rail
  vanish. This is now covered by a law test.
- **Access levels:** `staff` / `finance` / `control`. `getRequiredClubOperationAccess()` returns
  `null` for an unrecognised suffix - which the guard treated as "no check needed".
- **One read, three surfaces.** `ca_club_operations_overview(p_club_id)` is a single staff-gated
  read returning `kpis`, `counts` (11 work queues), `alerts` (each carrying a severity and the
  registry `tool` id it belongs to), and finance figures **only** for finance roles.
  `/operations`, `/finance` and `/control` all read it through the same 15-second shared cache,
  so mounting the rail plus a page costs one query.
- **Badging law adopted in Phase 1:** a badge always means _this many things are waiting for a
  person_. Volume is never a signal. A group rollup is computed over the viewer's own permitted
  items, never over a queue they cannot open.

### 6.2 The systemic failure mode this programme keeps finding

**A client `.update()` against a table with no matching RLS UPDATE policy returns HTTP 204,
zero rows, and NO error.** PostgREST does not distinguish "you may not" from "nothing matched".
Every place the codebase followed that with `toast.success(...)` became a lie. Confirmed
instances:

| Surface                            | Table               | What the operator saw                                                  |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| Anti-Cheat "Submit Review"         | `anti_cheat_flags`  | "Flag reviewed successfully." - **nothing was written, ever**          |
| Disputes "Start Review"            | `disputes`          | Threw, shown as a failure (so the `under_review` tab could never fill) |
| Disputes "Escalate"                | `disputes`          | Same                                                                   |
| `AgentService.assignPlayerToAgent` | `agents`            | Returns `true` unconditionally                                         |
| Clawback claim step                | `chip_transactions` | "Transaction already clawed back" - a cause that was never true        |

**The fix pattern used throughout:** a `SECURITY DEFINER` function, `SET search_path TO
'public'`, revoked from `anon`, granted to `authenticated`, that checks a named gate, does the
write, reads `GET DIAGNOSTICS v_updated = ROW_COUNT`, and returns
`jsonb_build_object('ok', v_updated > 0, 'reason', ...)`. The client then **must** check
`if (!outcome.ok) throw`.

### 6.3 The second systemic failure mode: the slug in a uuid argument

Club routes are addressed by **slug** (`deep-stack-society-11192`), sometimes by a **6-digit
code**, sometimes by a uuid. Many pages took `useParams().clubId` and passed it straight into a
`uuid` RPC argument or `.eq('club_id', ...)`. Postgres answers `22P02 invalid input syntax for
type uuid`, and every catch block turned that into an empty state.

- `AntiCheatPage` did this on **every one of its queries**. It has shown six zeros and the
  words "Club Is Clean" on every club URL since it shipped. Nothing went red.
- `AgentService.createAgent` did it to `fn_create_agent`.
- `AgentDashboardPage` did it to `CreditService.setCreditLine`.
- **Always call `resolveClubUUID()` first.**

### 6.4 Permission and grant discoveries (all verified live)

| Object                                                                                                                                                        | Finding                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anti_cheat_flags`                                                                                                                                            | `authenticated` gets ONE policy: read flags raised against yourself. No staff read, no UPDATE. All 14 rows have `club_id IS NULL`.                                                       |
| `disputes`                                                                                                                                                    | One SELECT policy. No UPDATE.                                                                                                                                                            |
| `chip_transactions`                                                                                                                                           | SELECT policies only. **No UPDATE policy at all.**                                                                                                                                       |
| `agents`                                                                                                                                                      | No UPDATE for `authenticated`. SELECT is cashier-scoped: `user_id = auth.uid()` OR `fn_club_cashier_scope(...) = 'all'` OR downline. **An owner does get `'all'`**, so agent lists work. |
| `agent_commissions`                                                                                                                                           | `authenticated` may read **only their own rows** (`user_id = auth.uid()`). **A club owner has no policy on this table.** This is why payables needed a definer function.                 |
| `wallets`                                                                                                                                                     | SELECT + INSERT for self only. **No UPDATE policy.**                                                                                                                                     |
| `audit_trail`                                                                                                                                                 | No INSERT for `authenticated` - the client audit insert always failed silently.                                                                                                          |
| `profiles`                                                                                                                                                    | UPDATE for self only.                                                                                                                                                                    |
| `club_members`                                                                                                                                                | UPDATE/DELETE allowed for `is_club_admin(club_id, auth.uid())`.                                                                                                                          |
| `blacklists`                                                                                                                                                  | INSERT granted to owner/co_owner/admin/**super_agent** with `WITH CHECK (banned_by = auth.uid())`. DELETE same roles. SELECT for owner/co_owner/admin or any active agent in the club.   |
| `settlement_periods`                                                                                                                                          | SELECT for owner/co_owner/admin/**agent**.                                                                                                                                               |
| `settlement_invoices`                                                                                                                                         | SELECT via `fn_is_platform_admin()` or `fn_is_club_admin_uid(club_id)`.                                                                                                                  |
| `fn_clawback_chips_atomic`                                                                                                                                    | **SECURITY INVOKER, and `authenticated` has NO EXECUTE.** Dead.                                                                                                                          |
| `wallet_user_transfer`                                                                                                                                        | **SECURITY INVOKER, and `authenticated` has NO EXECUTE.** Dead.                                                                                                                          |
| `fn_agent_wallet_send`                                                                                                                                        | definer, granted, `search_path=public, pg_temp`. **The working send.**                                                                                                                   |
| `fn_agent_wallet_reversible`                                                                                                                                  | definer, granted. **The working reversible list.**                                                                                                                                       |
| `fn_agent_wallet_claim_back`                                                                                                                                  | definer, granted. **The working undo.**                                                                                                                                                  |
| `fn_admin_update_agent`                                                                                                                                       | definer, granted. Owns every credit rule. **Refuses `is_prepaid = true` together with a non-zero limit**, and refuses a zero limit for a non-prepaid agent.                              |
| `fn_agent_attach_player`, `fn_create_agent`, `fn_wallet_type_transfer`, `fn_my_agent_roles`, `fn_agent_downline_rake(_summary)`, `fn_redeem_club_invite_code` | all definer + granted                                                                                                                                                                    |

### 6.5 Data-shape discoveries (all measured live, 2026-09-03)

| Fact                                                                         | Figure                                                                                | Why it matters                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip_transactions` types `agent_to_player`, `promo_agent_to_player`, `send` | **0 rows each, estate-wide**                                                          | The clawback list filtered on exactly these. It was always empty.                                                                                                                     |
| `chip_transactions` type `agent_wallet_send`                                 | 416 rows                                                                              | The only real agent distribution type                                                                                                                                                 |
| `collusion_tracking`                                                         | 169,530 rows: **7 open, 169,523 cleared**                                             | 169,519 auto-cleared 2026-08-18, note: _"both players are house-run AI horses, which cannot collude with each other. Detector fixed at write time in smarter-poker-workers edf5691."_ |
| `collusion_tracking_status_check`                                            | allows `open \| reviewed \| cleared \| actioned`                                      | `'dismissed'` is **not** a legal value - see Setbacks                                                                                                                                 |
| `disputes_target_type_check`                                                 | `agent_settlement \| cashout_request \| credit_invoice \| commission_payout`          | A probe using `'transaction'` was rejected                                                                                                                                            |
| `agent_commissions`                                                          | 2,038,305+ rows, **2,054,257 unsettled**                                              | **Nothing on this estate has ever been marked settled.** `settled_at IS NULL` is not yet a selective predicate.                                                                       |
| Deep Stack Society agent commissions                                         | 259,135 rows, all unsettled, **65,790.44 chips owed**                                 | The payables page showed 36,657                                                                                                                                                       |
| `club_members`                                                               | 1,575 rows carry `agent_id`; **417 carry `invited_by`**                               | These are different people. `AgentDashboardPage` read the wrong one.                                                                                                                  |
| `club_members` PK                                                            | **`(club_id, user_id)` - there is NO `id` column**                                    | A probe caught this                                                                                                                                                                   |
| `club_members` money columns                                                 | `chip_balance`, `held_chips`, `locked_chips`, `promo_balance`, `credit_used`          | **Deleting a membership row destroys chips.** One member held 10,067.64.                                                                                                              |
| `settlement_periods` / `settlement_invoices` for this club                   | **0 rows each**                                                                       | The static "Settlement Schedule" described a run that does not exist                                                                                                                  |
| `agent_settlements`, `commission_payouts` tables                             | **do not exist**                                                                      | Real payables live in `agent_commissions` + `settlement_invoices`                                                                                                                     |
| `blacklists`                                                                 | read by `atomic_table_buyin`, `atomic_table_rebuy`, `atomic_tournament_register`      | An exclusion genuinely blocks play - it is not a label                                                                                                                                |
| Deep Stack Society                                                           | 32 agents, 417 members, 226 live tables, 1,567 tables total, ~273,794 hands in window | Phase 4 context                                                                                                                                                                       |

### 6.6 Realtime and background

- `user_reports` is **absent from the `supabase_realtime` publication** and its RLS grants a
  moderator nothing. The subscription on `ReportReviewPage` could never deliver a row. Replaced
  with 45s visibility-gated polling.
- `fn_blacklists_audit` is a trigger on `blacklists` that writes `anti_cheat_events` rows
  (`player_banned` on INSERT, `player_unbanned` on DELETE). It does **not** fire on UPDATE.
- `AgentRakeService` subscribes to INSERTs on `agent_commissions` with a **randomised channel
  name**, so repeated calls open new channels rather than reusing one. (Known, not fixed.)
- The collusion detector is owned by a **different repo** (`smarter-poker-workers`, commit
  `edf5691`). Its horse-vs-horse ruling is recorded in the rows. **This workspace has no
  standing to overturn it.**

### 6.7 Existing technical debt observed but not addressed

- `AgentService.assignPlayerToAgent`, `promoteToAgent`, `selfTransfer`, and (before deletion)
  `getRecentDistributions` had **zero callers anywhere in `src/`**. `assignPlayerToAgent` in
  particular writes to `agents` (a guaranteed no-op) and returns `true` regardless - a trap for
  the next reader. **STILL PRESENT.**
- `AgentService.selfTransfer(agentId, ...)` passes its `agentId` argument into `p_user_id` -
  the parameter is named for the agents PK but must be a **user id**. No caller exists today.
  **STILL PRESENT.**
- Hard caps with no UI notice: `QUERY_LIMITS.MODERATE = 500` on agents and on an agent's
  players; `.limit(50)` on `agent_commissions` history; `.limit(100)` on `chip_transactions`
  with a "Load More" that can never exceed it; `AgentRakeService` `p_limit ?? 500`.
- `AgentDashboardPage` has a sessionStorage SWR cache that truncates to 30/20/30/20 rows and
  then computes stat-card totals from the truncated arrays on a cache hit.
- `AgentDashboardPage:98` `isRefreshing` is set but **never read** - bus-driven reloads are
  invisible.
- Several controls are **empty wrappers left behind when emoji were stripped**, with a stray
  leading space in the adjacent label. One (the Credit Limits Cancel button) had _no content at
  all_ - fixed in Phase 3. Others remain in `AgentManagementPage` and `AgentDashboardPage`.
- Non-ASCII decorative glyphs (diamond, arrow, bullet, clock, cross, circle, check, refresh, list, spade, square and return glyphs, plus a warning sign and a return arrow that render AS EMOJI on iOS and Android) are scattered through
  both agent pages. `check-no-emoji` passes, so they are tolerated, but a warning sign and a return arrow render as
  emoji on iOS/Android.

---

## 7. Work Completed During This Chat

Six commits, all on `feat/club-operations-full-upgrade`, all pushed. **43 files changed,
+7,968 / -782** against `origin/main`.

### Workstream A - Phase 1: the shell tells the truth (`6f59162cd`)

**Reason:** the workspace advertised 26 tools and read nothing; the guard and the registry had
drifted; three built tools had no door.

- **Security hole closed.** `anti-cheat` was in `DEFINITIONS` but missing from
  `OPERATION_SUFFIXES`, so `getRequiredClubOperationAccess()` returned `null`, the guard
  checked nothing, and **any plain member could open the collusion console by typing the URL**.
  The same absence made the rail vanish on that page.
- New migration `20260903160000` adding `ca_club_operations_overview(p_club_id uuid)`: staff-
  gated single read; `kpis`, `counts` (11 queues), `alerts` (severity + registry tool id);
  finance figures only for finance roles. **Seats counted as DISTINCT PEOPLE**, not seat rows
  (`ca_club_dashboard_stats` counts rows and calls it "Seated Now", which is why that page and
  Players have never agreed). It names its internal escape
  (`session_user IN ('postgres','supabase_admin') OR auth.role()='service_role'`) instead of the
  `auth.uid() IS NULL OR` shortcut `ca_can_view_club` uses. **No `is_horse` anywhere.**
- Three doorless built tools registered: `promo-vault`, `bomb-pot-report`, `table-management`.
- Promotions tile renamed **Player Offers** - it opened the player feed, not a campaign manager.
- `<main>` -> `<section>` in `ArenaWorkspacePages` (AppLayout already renders one, so six pages
  shipped two landmarks).
- Three rail rewrites that could never select anything replaced with a group-parent fallback.
- Files: 15 changed. Tests: 3 new files.
- **Verified:** anonymous PostgREST call refused `401/42501`; probed live against Deep Stack
  Society - 417 members, 226 live tables, 183 players seated, 122,786 hands today, single-digit
  ms.

### Workstream B - Phase 1 verification pass (`42f76d9ab`)

**Reason:** Dan's per-phase gate. Writing the missing tests found **four real defects in the
agent's own Phase 1 work**:

1. The bus nudge went through the 15s shared read cache, so a badge could not refresh until the
   next 60s poll. `load()` now takes `silent` and `force` **independently**.
2. `alerts={alerts}` **never landed on either sub-workspace** - the patch anchor stopped
   matching after Prettier rewrapped the line above it. The prop is optional, so `tsc` was
   happy. Found only by mounting the pages in a test.
3. The rail printed the workspace total **twice** (identity plate + Overview item).
4. A failed refresh dropped the age of the numbers still on screen.

Gaps closed: the cashier badge counted **1 of its 3 queues** (registry items now declare
`signals: []` as a **list**, and a contract test asserts every declared signal is a count the
RPC actually returns); the reading strip got a skeleton resting state; `tickets_outstanding`
and `blacklist_active` surfaced.

### Workstream C - Phase 2: an integrity decision is written down (`ad91f43ab`)

**Reason:** four pages under Club Control, three with controls that reported success and wrote
nothing.

- Migration `20260903170000`: one gate `fn_ca_can_review_integrity` (owner/co_owner/admin,
  `auth.uid() IS NOT NULL` **in the gate itself**) behind seven functions:
  `fn_club_anti_cheat_flags`, `fn_review_anti_cheat_flag`, `get_anti_cheat_stats`,
  `detect_collusion_pairs`, `fn_ca_dismiss_collusion_pair`, `fn_dispute_start_review`,
  `fn_dispute_escalate`. Plus `idx_collusion_tracking_window` and `idx_collusion_tracking_pair`
  on a 169,530-row table whose only index was the primary key.
- `get_anti_cheat_stats` **rewritten to the 5 keys the page reads** - it returned 7 different
  ones, 5 of them literal zeros, and was the only one of three detectors that was not definer.
- `detect_collusion_pairs` rescoped from `club_members` (which yielded **0 pairs from 38,267
  tracking rows** for a club where 556 of 557 tracked players are horses - a direct 10.5
  violation) to "both players sat at this club's tables", and **split by `pattern_type`**.
- Client: `AntiCheatPage` resolves the slug to a uuid **first**; kick goes through the engine's
  `POST /admin/kick` via the new `IntegrityActionService` (it used to stamp
  `table_seats.left_at` from the browser - the CLAUDE.md 11.5 stack-destroying write - and had
  **no `tableId` at any call site**, so the seat branch was skipped and the compensating audit
  insert was refused by RLS); anomalies tab relabelled to what its SQL measures (winners of
  40BB+ pots, **not** "players who folded strong hands on the river"); reports polls instead of
  subscribing to an unpublished table and states its 100-row cap; blacklist picks from the
  roster, names the person, warns when they are still seated, sweeps expired rows.
- `anti-cheat` moved from `staff` to `control` access and joined `CONTROL_SUFFIXES`.
- **`get_anti_cheat_stats` needed `DROP FUNCTION` first** - `CREATE OR REPLACE` cannot change a
  return type (json -> jsonb).

### Workstream D - Phase 2 verification pass (`13de9e737`)

**Reason:** Dan's per-phase gate. Probing found **two defects in the agent's own Phase 2 work**:

1. **`fn_ca_dismiss_collusion_pair` wrote `status = 'dismissed'`**, which
   `collusion_tracking_status_check` forbids. The Clear button would have thrown a raw
   constraint violation at every operator who pressed it. The word came from
   `detect_collusion_pairs`, which had always filtered `status <> 'dismissed'` - **a predicate
   true for every row in the table**, because no row can hold that value. That filter had never
   excluded anything.
2. **Far worse:** 169,519 of the 169,530 rows were auto-cleared on 2026-08-18 by the detector
   owners. The useless filter let all of them back in, so the Phase 2 screen would have shown
   this club's operator **5,591 pairs a known detector bug had already accounted for**.
   _Replacing "0 pairs, wrongly" with "5,591 pairs, wrongly" is not an improvement._

Migration `20260903180000`: screens only `status = 'open'`; returns `closed_pairs` alongside so
an empty queue reads as "the screen ran and closed itself"; renames `win_rate` -> `screening`
(there are **seven** pattern types and 3 of the 7 open rows estate-wide are
`TIMING_CORRELATION`, which "win rate" mislabelled); counts the window off the maintained
`club_hand_daily` rollup (75ms vs 448ms). **Call went from ~1,400ms to 397ms.**

Also fixed: the **phantom `AntiCheatFlag.details` column**. The interface declared it; the table
does not have it. The real evidence column is `reason`. The review dialog's evidence block had
been `undefined && ...` since it shipped - **no reviewer has ever seen why a flag was raised
while deciding what to do about it.**

**This is explicitly NOT a horse exclusion.** The horse-vs-horse ruling was made at write time
by the team that owns the detector and is recorded in the row.

### Workstream E - the entry-chunk regression (`6abfa3c33`)

**Reason:** CI caught a regression `all-gates.sh` cannot see.

`scripts/ci/entry-chunk-delta.mjs` is **not part of `all-gates.sh`**. It fired:

```
3 module(s) entered the entry chunk
  src/hooks/useClubOperationsOverview.ts
  src/hooks/useVisibilityRefresh.ts
  src/utils/clubDashboard.ts
```

`AppLayout` mounts `ClubOperationsRail` on every page with a global header, so Phase 1's badge
hook put club-staff machinery **and its query** into the bundle every player downloads before
first paint.

**Fixed by splitting the rail, not by updating the baseline.** `ClubOperationsRail` stays in the
entry and answers two questions that were already in first paint for other reasons (is this an
operations route, is the viewer staff); `ClubOperationsRailBody` holds everything that reads and
loads lazily with `<Suspense fallback={null}>` (no fallback: a rail that flashes an empty
chassis and then fills is worse than one that arrives a beat later). Entry chunk went 203 -> 202
modules; the baseline was refreshed in the same commit to record that
`ClubOperationsRail.module.css` left.

### Workstream F - Phase 3: the agent network (`8f906f778`)

**Reason:** four controls that could not do what their labels said, each for a different reason.

**Database (migration `20260903200000`):**

- `fn_ca_can_manage_agents(p_club_id)` - owner/co_owner/admin, `auth.uid()` required.
- `fn_ca_agent_payables(p_club_id)` - reads the real commission ledger; returns per agent the
  amount owed, `rows_behind`, `oldest_unsettled`, funding position, and the **old estimate
  alongside** so an operator who has been reconciling against it sees both. Capped at 200 rows
  with the full totals computed over all agents.
- `fn_ca_ban_club_player(p_club_id, p_user_id, p_reason, p_expires_at)` - writes the exclusion,
  refuses `cannot_ban_the_owner` / `cannot_ban_club_staff` / `not_a_member_of_this_club`,
  reports `chips_held`, `credit_used`, `live_seats`, `was_already_excluded`.

**Database (migration `20260903210000`):** dropped and rebuilt
`agent_commissions_unsettled_idx` with `INCLUDE (amount, created_at)`, making the payables
aggregate a `Parallel Index Only Scan`.

**Client:**

- Ban Player: was `else if (type === 'ban') { toast.success('Player banned'); }`. Now calls the
  RPC, checks `ok`, maps refusal reasons to operator English, offers engine removal when
  `live_seats > 0`, and warns about held chips and drawn credit.
- Clawback panel: repointed at `fn_agent_wallet_reversible` + `fn_agent_wallet_claim_back`.
  `AgentService.clawbackDistribution` and `getRecentDistributions` **deleted**.
  `ReversibleDistribution` interface added. New `.reversible*` CSS classes replaced inline
  styles.
- Payouts tab: fabricated table and static "Settlement Schedule" replaced with the real read.
- `AgentDashboardPage`: transfer -> `fn_agent_wallet_send`; prepaid -> `fn_agent_wallet_send`
  into `agent_wallet`; revoke -> new `CreditService.lowerCreditLine`. Options relabelled
  "Set Credit Line To" / "Send Prepaid Chips" / "Reduce Credit Line By". Notes now passed.
- Downline read changed from `invited_by` to `agent_id` (with `invited_by` kept as a fallback).
- `getAgentPlayers(agentId, clubId?)` gained a club filter; `SuperAgentDashboard` passes it.
- `createAgent` resolves the club uuid.
- Transfer id `agent.id` -> `agent.userId`; `AGENT_ROLE_LABELS` map on both pages;
  `liveSeatTableIds()` extracted into `IntegrityActionService` and shared.
- Counts wrapped in `fmt()`; the empty Cancel button given content; `transferAmount` reset.

---

## 8. Visual And Product Decisions

**No design references, mockups, uploaded images, or locked visual assets were provided by Dan
at any point in this session.** There is no approved-reference-image register to hand over.

What exists instead, and should be treated as locked because it is now enforced by tests:

| Decision                                                                                                                                                                        | Where enforced                                          | Locked?                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| A badge means "this many things are waiting for a person"; volume is never a signal                                                                                             | `tests/unit/clubOperationsRegistryIntegrity.test.ts`    | **Locked**                                      |
| A group rollup is computed over the viewer's own permitted items only                                                                                                           | same                                                    | **Locked**                                      |
| The identity plate IS the Overview link; the Overview item in the strip must not repeat the same number six pixels away                                                         | same                                                    | **Locked**                                      |
| The rail's landmark is `aria-label="Club Operations Sections"` and lives in `ClubOperationsRailBody`                                                                            | `tests/config/clubArenaAccessibilityFoundation.test.ts` | **Locked**                                      |
| The rail shell must not import anything that queries                                                                                                                            | `clubOperationsRegistryIntegrity`                       | **Locked**                                      |
| Six skeleton tiles hold the reading strip's height, marked `aria-busy`                                                                                                          | `club-operations-page.test.tsx`                         | **Locked**                                      |
| A failed read says which it is: "Live Readings Unavailable, Last Read 3m Ago" vs "Live Readings Restricted For This Role" - never silence, never zeros                          | `club-operations-page.test.tsx`                         | **Locked**                                      |
| Anti-Cheat says "The Integrity Readings Could Not Be Loaded" or "Integrity Review Is Restricted To Club Owners And Administrators" - **never** "Club Is Clean" on a failed read | `anti-cheat-console.test.tsx`                           | **Locked**                                      |
| The collusion tab shows `chip_dump` and `screening` as separate groups, plus an "Already Closed" tile; each row names its own pattern                                           | `anti-cheat-console.test.tsx`                           | **Locked**                                      |
| The payouts tab shows the real owed figure AND the superseded estimate, labelled, for one release                                                                               | `theAgentNetworkReachesSomething.test.ts`               | **Locked for one release** - see Remaining Work |
| Mobile hero on `/operations` cut from 460px to 300px                                                                                                                            | -                                                       | Implemented, not test-locked                    |
| `.reversibleRow` stacks vertically below 480px                                                                                                                                  | `AgentManagementPage.module.css`                        | Implemented, not test-locked                    |
| Wide tables scroll inside `.tableScroll` (`overflow-x:auto`); the page body never scrolls sideways                                                                              | -                                                       | Implemented, not test-locked                    |

**Rejected / obsolete - do not reintroduce:**

- The `win_rate` label for the non-chip-dump collusion group. **Rejected** - it mislabels five
  of seven pattern types.
- Updating `entry-chunk-baseline.json` to accept the three staff modules in first paint.
  **Rejected** in favour of splitting the rail.
- Deleting the `club_members` row as part of a ban. **Rejected** - it destroys chips.
- Writing a new definer clawback function. **Rejected** - the platform already had a correct
  one; the fix was deletion plus repointing.
- The static "Settlement Schedule" copy (Sunday 11:59 PM PST etc.). **Removed** - it described
  a settlement run this club does not have.

---

## 9. Functional And Architectural Decisions

Status key: **DONE** = implemented and verified - **PARTIAL** = implemented, gaps named -
**SPEC** = specified in the plan doc only - **NOT STARTED**

| Area                                                                                                                              | Decision / state                                                                                                                         | Status                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Operator permission model                                                                                                         | Three access levels (`staff`/`finance`/`control`); the registry is the single source; a definition without its suffix fails a law test   | **DONE**               |
| Anti-cheat access                                                                                                                 | `control`, not `staff`                                                                                                                   | **DONE**               |
| One overview read for three surfaces, 15s shared cache                                                                            | `useClubOperationsOverview`                                                                                                              | **DONE**               |
| Badge semantics                                                                                                                   | "waiting for a person"; signals declared as a list; contract-tested against the RPC                                                      | **DONE**               |
| Integrity write path                                                                                                              | All seven functions behind `fn_ca_can_review_integrity`; zero rows = failure                                                             | **DONE**               |
| Player removal from a live table                                                                                                  | **Engine only**, via `POST /admin/kick`. Never `table_seats` from the browser.                                                           | **DONE**               |
| Collusion screening                                                                                                               | Open rows only; `closed_pairs` reported; pattern named per row                                                                           | **DONE**               |
| Horses in counts                                                                                                                  | Never filtered. The horse-vs-horse collusion ruling belongs to the detector owners.                                                      | **DONE**               |
| Agent payables                                                                                                                    | Read from `agent_commissions`, definer-gated; old estimate shown alongside                                                               | **DONE**               |
| Ban                                                                                                                               | Exclusion + audit; **never** deletes membership; **never** closes a seat; reports chips/credit/seats                                     | **DONE**               |
| Agent undo (clawback)                                                                                                             | Uses the platform's existing `fn_agent_wallet_reversible` / `fn_agent_wallet_claim_back`, with the DB's own clock and an idempotency key | **DONE**               |
| Prepaid funding                                                                                                                   | `fn_agent_wallet_send` to `agent_wallet`                                                                                                 | **DONE**               |
| Credit line reduction                                                                                                             | `CreditService.lowerCreditLine` via `fn_admin_update_agent`; moves to prepaid at zero; refuses when drawn > new limit                    | **DONE**               |
| Agent downline attribution                                                                                                        | `club_members.agent_id`, with `invited_by` as a legacy fallback                                                                          | **DONE**               |
| Agent player scoping                                                                                                              | One club per query                                                                                                                       | **DONE**               |
| Rakeback / commission accrual                                                                                                     | Owned by other work (migration `20260903163422 commission_accrues_for_every_agent_in_the_chain` landed on main today)                    | **NOT THIS PROGRAMME** |
| Settlement periods / invoices                                                                                                     | Read-only surface only; this club has none                                                                                               | **SPEC** (Phase 6)     |
| Club dashboard tables/leaderboard/tournaments                                                                                     | Every defect confirmed and written down                                                                                                  | **SPEC** (Phase 4)     |
| Players and player records                                                                                                        | Confirmed defects listed                                                                                                                 | **SPEC** (Phase 5)     |
| Finance truth                                                                                                                     | Confirmed defects listed                                                                                                                 | **SPEC** (Phase 6)     |
| Money movement                                                                                                                    | Confirmed defects listed                                                                                                                 | **SPEC** (Phase 7)     |
| Club control (rules, promo vault, settings)                                                                                       | Confirmed defects listed                                                                                                                 | **SPEC** (Phase 8)     |
| Cash games / tournaments / spins / heads-up / bomb pots / RIT / insurance / straddles / VPIP / anti-rathole / weighted rake / BBJ | **Not touched by this programme.** Owned by the engine and the chip-standard programme.                                                  | **OUT OF SCOPE**       |

---

## 10. Exact Current State

Verified 2026-09-03 ~21:52 UTC.

```
Working directory : /Users/smarter.poker/Documents/.agent-trees/club-arena/ops-upgrade
Repo root         : same (git worktree)
Git dir           : /Users/smarter.poker/Documents/club-arena/.git/worktrees/ops-upgrade
Branch            : feat/club-operations-full-upgrade
HEAD              : 8f906f778  feat(club-operations): the agent network's controls reach something
git status        : CLEAN (no staged, no unstaged, no untracked)
vs origin/branch  : 0 ahead, 0 behind  (fully pushed)
vs origin/main    : 11 ahead, 3 behind (6 of the 11 are this work; 5 are merge commits)
```

- **Staged changes:** none.
- **Unstaged changes:** none.
- **Untracked files:** none. (Scratch files `.probe.sql`, `.probe2.sql`, `.record.sql`,
  `.apply.sh`, `.runprobe.sh`, `.db-gates.sh`, `.commit-msg-*.txt` were all created and deleted
  during the session. **Verified gone.**)
- **Generated output:** `dist/` exists (last built 2026-09-03 16:28 local). Untracked/ignored.
- **Running processes:** **none.** No vite dev server, no preview server, no node process in
  this worktree.
- **Database:** production Supabase `kuklfnapbkmacvwxktbh`. All five migrations **applied and
  recorded**. All ten declared functions exist, are `SECURITY DEFINER`, have
  `authenticated = true` / `anon = false` EXECUTE. **Verified by live query.**
- **Build:** `vite build` green as of the last `all-gates.sh` run.
- **Local test status:** `all-gates.sh` **OK - every local gate passed** (last run 2026-09-03
  ~21:15 UTC). `entry-chunk-delta` OK. All 14 DB/CI gates + lint OK.
- **CI status:** PR #2853, `state=open`, `merged=false`, `mergeable=true`,
  **`mergeable_state=blocked`**. On `8f906f778`: `Silent Revert Guard` success,
  `Telemetry Exposure` success, `Agent Open PR` success, **`CI  -  Build & Type Safety`
  `in_progress`** at the time of writing.
- **Deployment status (re-verified 22:05 UTC): MERGED AND PUBLISHED.**
  - PR #2853: `state=closed`, `merged=true`.
  - Squash commit on `main`: **`c22a3bb00`** - _"feat(club-operations): the workspace reads the
    club it governs (#2853)"_. All six branch commits are inside it.
  - Verified present on `main` via `git cat-file -e`:
    `supabase/migrations/20260903200000_an_agent_payout_is_a_record.sql`,
    `src/components/navigation/ClubOperationsRailBody.tsx`,
    `tests/unit/theAgentNetworkReachesSomething.test.ts`.
  - `git merge-base --is-ancestor c22a3bb00 71b310c01` -> **YES**.
  - `build-info.json` at 22:00:20Z reports
    `ca_sha = 71b310c016a92ece98ca484dc3e8ec46ec9f84a8`, which **contains this work**.
  - **The branch `feat/club-operations-full-upgrade` still exists at `8f906f778`** and is now
    fully contained in `main`. **Cut a fresh branch from `main` for Phase 4** rather than
    reusing it.

---

## 11. Changed-File Ledger

All files below are **committed and pushed**. There are **no user-owned changes in the
worktree** - `git status` is clean.

| File                                                             | Status   | Purpose                       | What changed                                                                                                                                                                                                                                                        | Verified                    | Committed |
| ---------------------------------------------------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------- |
| `src/config/clubOperationsNavigation.ts`                         | Modified | Tool registry                 | +`anti-cheat` to `OPERATION_SUFFIXES` (closed a live permission hole); +3 doorless tools; Promotions -> Player Offers; `signals?: []` as a list; `getClubOperationBadge()`; group-parent fallback; `mediaUrl()` art; anti-cheat staff->control + `CONTROL_SUFFIXES` | Tests + live                | Yes       |
| `src/hooks/useClubOperationsOverview.ts`                         | Created  | Shared overview reader        | 15s shared cache, inflight dedupe, independent `silent`/`force`, `resetClubOperationsOverviewCache()`                                                                                                                                                               | Tests                       | Yes       |
| `src/components/navigation/ClubOperationsRail.tsx`               | Modified | Entry-chunk shell             | Reduced to route+staff check; lazy-loads the body                                                                                                                                                                                                                   | Tests + entry-chunk gate    | Yes       |
| `src/components/navigation/ClubOperationsRailBody.tsx`           | Created  | Lazy reading half             | Everything that queries or renders                                                                                                                                                                                                                                  | Tests                       | Yes       |
| `src/components/navigation/ClubOperationsRail.module.css`        | Modified | Rail styles                   | +22 lines                                                                                                                                                                                                                                                           | check-css-modules           | Yes       |
| `src/pages/club/ClubOperationsPage.tsx`                          | Modified | `/operations`                 | Reading strip, alerts, badges, skeletons, freshness; exports `ago()`/`freshnessLabel()`                                                                                                                                                                             | 14 tests                    | Yes       |
| `src/pages/club/ClubOperationsPage.module.css`                   | Modified | its styles                    | +285 lines                                                                                                                                                                                                                                                          | check-css-modules           | Yes       |
| `src/pages/workspaces/ArenaWorkspacePages.tsx`                   | Modified | `/finance`, `/control`        | `<main>`->`<section>`; `useClubWorkspaceGroup()`; readings + alerts                                                                                                                                                                                                 | 10 tests                    | Yes       |
| `src/pages/workspaces/ArenaWorkspacePages.module.css`            | Modified | its styles                    | +135 lines                                                                                                                                                                                                                                                          | check-css-modules           | Yes       |
| `src/pages/AntiCheatPage.tsx`                                    | Modified | Integrity console             | Club resolved first; RPC reads/writes; engine kick; phantom `details` -> `reason`; anomalies relabelled; `loadError`; collusion `chip_dump`/`screening`/`closed_pairs`; exports `evidenceSummary()`                                                                 | 11 tests + live probe       | Yes       |
| `src/pages/AntiCheatPage.module.css`                             | Modified | its styles                    | +17 lines                                                                                                                                                                                                                                                           | check-css-modules           | Yes       |
| `src/pages/ReportReviewPage.tsx`                                 | Modified | Moderation queue              | Dead realtime -> 45s visibility-gated poll; 100-row cap notice                                                                                                                                                                                                      | Tests                       | Yes       |
| `src/pages/ReportReviewPage.css`                                 | Modified | its styles                    | +16 lines                                                                                                                                                                                                                                                           | -                           | Yes       |
| `src/pages/BlacklistManagerPage.tsx`                             | Modified | Exclusion ledger              | Roster picker (300ms debounce, last-wins); names; seated warning + engine removal; `clearExpired`; `expiredEntries`                                                                                                                                                 | Tests                       | Yes       |
| `src/pages/BlacklistManagerPage.module.css`                      | Modified | its styles                    | +112 lines                                                                                                                                                                                                                                                          | check-css-modules           | Yes       |
| `src/pages/AgentManagementPage.tsx`                              | Modified | Agent network console         | Ban wired; clawback repointed; payables table; transfer id; role labels; `fmt()`; Cancel button                                                                                                                                                                     | 32 tests + live probe       | Yes       |
| `src/pages/AgentManagementPage.module.css`                       | Modified | its styles                    | +110 lines (`.reversible*`, `.payout*`, `.tableScroll`)                                                                                                                                                                                                             | check-css-modules           | Yes       |
| `src/pages/AgentDashboardPage.tsx`                               | Modified | Agent dashboard               | Transfer/prepaid/revoke rewired; downline `agent_id`; club resolved; labels                                                                                                                                                                                         | Tests                       | Yes       |
| `src/pages/SuperAgentDashboard.tsx`                              | Modified | Super agent view              | Club-scoped players; `fmt()`; role labels; amount reset                                                                                                                                                                                                             | Tests                       | Yes       |
| `src/services/AgentService.ts`                                   | Modified | Agent service                 | Dead clawback deleted; `reversibleDistributions()`/`claimBackDistribution()` added; `createAgent` resolves club; `getAgentPlayers` club-scoped; `ReversibleDistribution` type                                                                                       | Tests                       | Yes       |
| `src/services/CreditService.ts`                                  | Modified | Credit service                | `setCreditLine` takes `reason`; new `lowerCreditLine()` with bound error                                                                                                                                                                                            | Tests                       | Yes       |
| `src/services/DisputeService.ts`                                 | Modified | Disputes                      | Both transitions through RPCs; checks `ok`; re-reads the row                                                                                                                                                                                                        | Tests + live probe          | Yes       |
| `src/services/IntegrityActionService.ts`                         | Created  | Engine actions                | `adminRemovePlayerFromClubTables()`, `liveSeatTableIds()`                                                                                                                                                                                                           | Tests                       | Yes       |
| `supabase/migrations/20260903160000_*.sql`                       | Created  | Phase 1 RPC                   | 368 lines                                                                                                                                                                                                                                                           | Applied + recorded + live   | Yes       |
| `supabase/migrations/20260903170000_*.sql`                       | Created  | Phase 2 gate + 7 fns          | 535 lines                                                                                                                                                                                                                                                           | Applied + recorded + live   | Yes       |
| `supabase/migrations/20260903180000_*.sql`                       | Created  | Phase 2 correction            | 211 lines                                                                                                                                                                                                                                                           | Applied + recorded + live   | Yes       |
| `supabase/migrations/20260903200000_*.sql`                       | Created  | Phase 3 gate + payables + ban | 332 lines                                                                                                                                                                                                                                                           | Applied + recorded + live   | Yes       |
| `supabase/migrations/20260903210000_*.sql`                       | Created  | Covering index                | 50 lines                                                                                                                                                                                                                                                            | Applied + recorded + live   | Yes       |
| `scripts/ci/schema-manifest.d/cowork-ops-upgrade.json`           | Created  | Declares 10 owned functions   | -                                                                                                                                                                                                                                                                   | check-definer-authorization | Yes       |
| `scripts/ci/entry-chunk-baseline.json`                           | Modified | First-paint baseline          | -1 module (`ClubOperationsRail.module.css`)                                                                                                                                                                                                                         | entry-chunk-delta           | Yes       |
| `tests/unit/clubOperationsRegistryIntegrity.test.ts`             | Created  | 108 cases                     | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/unit/clubOperationsOverviewContract.test.ts`              | Created  | 54 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/components/club-operations-page.test.tsx`                 | Created  | 14 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/components/club-operations-surfaces.test.tsx`             | Created  | 10 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/unit/integrityDecisionsAreWrittenDown.test.ts`            | Created  | 44 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/components/anti-cheat-console.test.tsx`                   | Created  | 11 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/unit/theAgentNetworkReachesSomething.test.ts`             | Created  | 32 cases                      | -                                                                                                                                                                                                                                                                   | Passing                     | Yes       |
| `tests/config/clubArenaAccessibilityFoundation.test.ts`          | Modified | Pre-existing                  | `blacklist-user-id` pin updated (input is a picker now); rail landmark now read from the body file                                                                                                                                                                  | Passing                     | Yes       |
| `tests/unit/discardedErrorReadRatchet.test.ts`                   | Modified | Pre-existing ratchet          | `AgentService.ts` baseline 12 -> 11                                                                                                                                                                                                                                 | Passing                     | Yes       |
| `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`                | Created  | The map                       | 550 lines                                                                                                                                                                                                                                                           | -                           | Yes       |
| `docs/changelog/2026-09-03-club-operations-phase-1-the-shell.md` | Created  | Changelog                     | -                                                                                                                                                                                                                                                                   | -                           | Yes       |
| `docs/changelog/2026-09-03-club-operations-phase-2-*.md`         | Created  | Changelog                     | -                                                                                                                                                                                                                                                                   | -                           | Yes       |
| `docs/changelog/2026-09-03-club-operations-phase-3-*.md`         | Created  | Changelog                     | -                                                                                                                                                                                                                                                                   | -                           | Yes       |

---

## 12. Asset Ledger

**No visual assets were created, uploaded, approved, or rejected in this session.** No reference
images, mockups, logos, icons, or frames were provided by Dan or generated by the agent.

The only asset-adjacent change: Phase 1 routes club operations **group art** through the
existing `mediaUrl()` helper rather than hardcoded paths. The underlying images are pre-existing
repository assets and were not modified.

**Files that exist only in the agent's cloud scratch space and are NOT in the repository** (they
were used to author repository content and are now redundant, since their content is committed):

| Scratch path                                | Repository destination                                                                                                                                       | Persisted?                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `/home/claude/phase2-changelog.md`          | `docs/changelog/2026-09-03-club-operations-phase-2-an-integrity-decision-is-written-down.md`                                                                 | **Yes, committed**                                                                           |
| `/home/claude/phase3-migration.sql`         | `supabase/migrations/20260903200000_an_agent_payout_is_a_record.sql` (then further edited in place in the worktree - **the worktree copy is authoritative**) | **Yes, committed**                                                                           |
| `/home/claude/agent-network-test.ts`        | `tests/unit/theAgentNetworkReachesSomething.test.ts` (then edited in place - **worktree copy authoritative**)                                                | **Yes, committed**                                                                           |
| `/home/claude/phase3-changelog.md`          | `docs/changelog/2026-09-03-club-operations-phase-3-the-agent-network.md`                                                                                     | **Yes, committed**                                                                           |
| `/home/claude/club-operations-upgrade.html` | none - an early published artifact                                                                                                                           | **NOT persisted to the repo.** Superseded by `OPERATIONS-UPGRADE-PLAN.md`. No action needed. |

**Risk:** the cloud scratch directory is ephemeral. Nothing of value lives only there - every
scratch file's content was committed. **Verified.**

---

## 13. Commands And Tools Used

All commands run from `/Users/smarter.poker/Documents/.agent-trees/club-arena/ops-upgrade`
unless noted.

### Critical environment notes for the next agent

- **Two shells.** `mcp__remote-devices__device_bash` runs in a Linux VM with the worktree
  mounted at `$HOME/mnt/ops-upgrade` - **it cannot run git** (the worktree's gitdir points
  outside the mount) and **cannot delete files** (`Operation not permitted`).
  `mcp__remote-devices__counselors__host_terminal` is the real Mac shell and **must be used for
  all git, psql, and long-running commands**.
- **`host_terminal` runs `/bin/sh`, not bash.** Process substitution `<(...)` fails. Wrap in
  `bash -lc "..."`. **A login shell is also required for `node`/`npm` to be on PATH.**
- **`host_terminal` has a ~60s response limit.** Long jobs must be backgrounded:
  `nohup bash -lc "cmd > /tmp/x.log 2>&1; echo \$? > /tmp/x.done" >/dev/null 2>&1 & disown`
  then poll. **`device_bash` background jobs are killed when the call returns - do not use it
  for long jobs.**
- **Quoting.** `bash -lc '...'` breaks on apostrophes inside heredocs. **Write SQL and commit
  messages to a file first** (via `device_bash` heredoc into the mounted worktree), then run
  `psql -f` or `git commit -F`.
- **psql connection:** `postgresql://postgres@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres`
  with `PGPASSWORD="$SUPABASE_DB_PASSWORD"`, `PATH="/opt/homebrew/bin:$PATH"`. The **pooler**
  host `aws-0-us-east-1.pooler.supabase.com` **does not work** (`tenant/user not found`).
- **The worktree has no `.env`.** Source `/Users/smarter.poker/Documents/club-arena/.env` and
  export `SUPABASE_URL=$VITE_SUPABASE_URL` - the CI gates want the un-prefixed name.

### Commands

| Command                                                                  | Purpose                                             | Result             | Changes files?   | Rerun?                          |
| ------------------------------------------------------------------------ | --------------------------------------------------- | ------------------ | ---------------- | ------------------------------- |
| `bash scripts/ci/all-gates.sh`                                           | tsc + 14 house rules + full vitest + build + bundle | **OK** (final run) | Writes `dist/`   | Yes, before every commit        |
| `node scripts/ci/entry-chunk-delta.mjs dist`                             | First-paint module gate                             | **OK, drift +0kB** | No               | **Yes - not in all-gates**      |
| `node scripts/ci/entry-chunk-delta.mjs dist --update`                    | Refresh the baseline                                | Used once          | **Yes**          | Only with justification         |
| `npx tsc --noEmit -p tsconfig.json`                                      | Type check                                          | Clean              | No               | Yes                             |
| `npx vitest run <files>`                                                 | Targeted tests                                      | 273/273 pass       | No               | Yes                             |
| `npm run lint`                                                           | ESLint                                              | OK                 | No               | Yes                             |
| `npm run build`                                                          | Vite production build                               | exit 0             | Writes `dist/`   | Yes                             |
| `node scripts/ci/check-migrations-applied.mjs`                           | Migration parity                                    | OK                 | No               | Yes                             |
| `node scripts/ci/check-applied-migrations-are-recorded.mjs`              | Ledger parity                                       | OK                 | No               | Yes                             |
| `node scripts/ci/check-definer-authorization.mjs`                        | Every definer fn is gated + declared                | OK                 | No               | Yes                             |
| `node scripts/ci/check-phantom-tables.mjs` / `check-phantom-columns.mjs` | No references to things that don't exist            | OK                 | No               | Yes                             |
| `node scripts/ci/check-route-targets.mjs`                                | Every route resolves                                | OK                 | No               | Yes                             |
| `node scripts/ci/check-painted-text-case.mjs`                            | Title case                                          | OK                 | No               | Yes                             |
| `node scripts/ci/check-maybe-single.mjs`                                 | No `.single()`                                      | OK                 | No               | Yes                             |
| `node scripts/ci/check-bus-wiring.mjs`                                   | MasterBus wiring                                    | OK                 | No               | Yes                             |
| `node scripts/ci/check-db-copy.mjs`                                      | Copy matches the live schema                        | OK                 | No               | Yes                             |
| `node scripts/ci/check-required-columns.mjs`                             | Required columns present                            | OK                 | No               | Yes                             |
| `node scripts/ci/check-no-orphaned-work.mjs`                             | No orphaned work                                    | OK                 | No               | Yes                             |
| `node scripts/ci/check-embed-relationships.mjs`                          | PostgREST embeds valid                              | OK                 | No               | Yes                             |
| `node scripts/ci/check-horses-are-players.mjs`                           | 10.5 compliance                                     | OK                 | No               | Yes                             |
| `node scripts/ci/check-css-modules.mjs`                                  | Every `styles.*` has a class                        | OK                 | No               | Yes                             |
| `psql ... --single-transaction -f <migration>`                           | Apply a migration                                   | 5 applied          | DB               | No - already applied            |
| `psql -f <probe>.sql` (BEGIN ... ROLLBACK)                               | Live verification as the real user                  | See Section 14     | No (rolled back) | Yes, safely                     |
| `git merge --no-edit origin/<branch>`                                    | Integrate autopilot's merges                        | Used 2x            | Yes              | As needed                       |
| `git commit -F <file>`                                                   | Commit with a long message                          | 6 commits          | Yes              | -                               |
| `git push origin HEAD`                                                   | Push                                                | 3 pushes           | No               | -                               |
| `gh api repos/.../actions/runs?...`                                      | Read CI state                                       | Works              | No               | Yes                             |
| `gh pr checks 2853`                                                      | **FAILS** - token lacks `checks:read`               | 403                | No               | Don't bother                    |
| `gh api .../check-runs`                                                  | **FAILS** - 403                                     | -                  | No               | Use `actions/runs` + `.../jobs` |
| `curl -s https://smarter.poker/hub/club-arena/build-info.json`           | What is published                                   | Works              | No               | Yes                             |

---

## 14. Verification And Test Results

| Verification                                   | Command Or Method                             | Result                                                                                        | Phase | Follow-Up                                                     |
| ---------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| Type check                                     | `npx tsc --noEmit`                            | **PASS**                                                                                      | All   | -                                                             |
| Lint                                           | `npm run lint`                                | **PASS**                                                                                      | All   | -                                                             |
| Unit + component tests (full suite)            | `all-gates.sh` -> `vitest run tests/`         | **PASS**, 12,401 tests, 895 files (final run)                                                 | All   | -                                                             |
| New tests only                                 | `npx vitest run <7 files>`                    | **PASS**, 273/273                                                                             | All   | Verified 21:50 UTC                                            |
| Production build                               | `npm run build`                               | **PASS**, exit 0                                                                              | All   | -                                                             |
| Bundle size                                    | `all-gates.sh`                                | **PASS**                                                                                      | All   | -                                                             |
| Entry-chunk delta                              | `node scripts/ci/entry-chunk-delta.mjs dist`  | **PASS**, 202 modules, drift +0kB                                                             | E, F  | **Run this every time - not in all-gates**                    |
| 14 DB/CI gates + lint                          | see Section 13                                | **ALL PASS**                                                                                  | All   | -                                                             |
| **Live: anon refused**                         | PostgREST call with no JWT                    | **401 / 42501**                                                                               | 1     | -                                                             |
| **Live: plain member refused integrity reads** | rolled-back txn, `request.jwt.claims`         | **42501 on all four**                                                                         | 2     | -                                                             |
| **Live: flag review writes + audits**          | rolled-back txn                               | `{"ok":true,"updated":1}` + exactly 1 `anti_cheat_events` row                                 | 2     | -                                                             |
| **Live: dispute transitions**                  | rolled-back txn                               | Both work; refuse re-entry with `not_open` / `already_escalated`                              | 2     | -                                                             |
| **Live: collusion payload**                    | rolled-back txn                               | `chip_dump_total 0, screening_total 0, closed_pairs 5591, analyzed_hands 273794` in **397ms** | 2     | -                                                             |
| **Live: foreign pair refusal**                 | rolled-back txn                               | `{"ok": false, "reason": "pair_did_not_play_here"}`                                           | 2     | -                                                             |
| **Live: agent gate**                           | rolled-back txn                               | owner `t`, plain member `f`                                                                   | 3     | -                                                             |
| **Live: payables refused for a member**        | rolled-back txn                               | **42501**                                                                                     | 3     | -                                                             |
| **Live: ban refused for a member**             | rolled-back txn                               | **42501**                                                                                     | 3     | -                                                             |
| **Live: payables headline**                    | rolled-back txn                               | 32 agents, **65,790.44 owed**, 259,135 rows, estimate 36,657.05                               | 3     | -                                                             |
| **Live: ban writes + audits**                  | rolled-back txn                               | 1 blacklist row, 1 `player_banned` event; returned `chips_held 10067.64`, `live_seats 0`      | 3     | -                                                             |
| **Live: ban refusals**                         | rolled-back txn                               | `cannot_ban_the_owner`, `not_a_member_of_this_club`                                           | 3     | -                                                             |
| **Live: rollback clean**                       | after ROLLBACK                                | 0 blacklist rows remain                                                                       | 3     | -                                                             |
| Payables performance                           | `psql \timing` + `EXPLAIN (ANALYZE, BUFFERS)` | 5,198ms -> **1,731ms** cold, ~450ms warm; `Parallel Index Only Scan`, 3,044 buffers vs 11,262 | 3     | Will improve further after autovacuum sets the visibility map |
| **CI on the branch**                           | GitHub Actions                                | **FAILED twice on flakes; third run in_progress**                                             | -     | **See Blockers**                                              |
| Visual regression                              | -                                             | **NEVER RUN** - no such harness found                                                         | -     | Consider                                                      |
| Responsive viewport testing                    | -                                             | **NEVER RUN.** Mobile-first CSS written but not viewed at 375px                               | -     | **Do this**                                                   |
| Accessibility audit                            | -                                             | **NOT RUN** beyond the repo's own `clubArenaAccessibilityFoundation` pins                     | -     | Consider                                                      |
| Manual browser walkthrough                     | -                                             | **NEVER DONE.** No page in this work has been opened in a browser by a human or by the agent. | -     | **Do this after publish**                                     |
| Migration rollback                             | -                                             | **NEVER TESTED.** No down-migrations were written.                                            | -     | See Defects D-06                                              |
| End-to-end money flow                          | -                                             | **NOT RUN** (would spend real chips - forbidden)                                              | -     | Correct as-is                                                 |

### Tests that FAILED during the session and what happened

| Test                                                                 | Failure                                                                                                                                                | Resolution                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `tests/no-hover-effects.law.test.ts`                                 | A `:hover` the agent added                                                                                                                             | Replaced with `:focus-visible`                                               |
| `tests/unit/noFixedSizeSourceWindows.test.ts`                        | `body.slice(0, 800)` in a new test                                                                                                                     | Used `sliceSqlStatement`                                                     |
| `tests/config/clubArenaAccessibilityFoundation.test.ts`              | Pinned `htmlFor="blacklist-user-id"` on an input that became a picker                                                                                  | Updated deliberately                                                         |
| `tests/config/clubArenaAccessibilityFoundation.test.ts` (2nd time)   | Rail landmark moved to the body file                                                                                                                   | Updated deliberately                                                         |
| `tests/unit/clubOperationsRegistryIntegrity.test.ts` (Phase 1's own) | `anti-cheat` moved staff -> control                                                                                                                    | Updated deliberately                                                         |
| `tests/unit/discardedErrorReadRatchet.test.ts`                       | (a) `CreditService.ts` 5 -> 6 discarded-error reads - **a real fault the agent introduced**; (b) `AgentService.ts` 12 -> 11 needs the baseline lowered | (a) error bound and thrown; (b) baseline lowered                             |
| 5 assertions in `theAgentNetworkReachesSomething.test.ts`            | The agent's own explanatory comments contained the strings the test asserted absent                                                                    | Assertions retargeted at call sites; two comments reworded                   |
| **CI: `server/src/engine/InsuranceRitExclusivity.test.ts`**          | Timeout under CI load. **Passes locally in 7.09s.**                                                                                                    | **NOT FIXED - flake, not this work**                                         |
| **CI: `src/engine/CryptoRandom.test.ts`**                            | `AssertionError: expected 33.428999999999995 to be less than 32.91` - a chi-square uniformity check on the shuffle                                     | **NOT FIXED - statistical flake, not this work**                             |
| **CI: Production Build**                                             | `sentry-cli releases new club-arena@1.0.1` -> **403 "You do not have permission"**                                                                     | **NOT FIXED - looks like an expired Sentry release token**                   |
| Local full-suite run under load                                      | 11 failures once, 1 another time (userEvent + git-spawn timeouts)                                                                                      | **All pass in isolation.** Machine load artefact. Final clean run was green. |

---

## 15. Setbacks, Failed Approaches, And Lessons

**Read this section. Each item cost real time.**

### S-01. Python `str.replace` patches fail SILENTLY after Prettier reformats

The single most expensive lesson. Twice:

- A `rep()` helper was called missing its `label` argument. The exception aborted the script
  **before the file write**, so **no edits landed at all** while `tsc` still reported 0 errors.
- `alerts={alerts}` never landed on either workspace page because the anchor string had been
  rewrapped by Prettier on a previous commit. The prop is **optional**, so `tsc` passed. Found
  only by mounting the pages in a test.

**Lesson: `assert s.count(old) == 1` before replacing, and `assert s != before` after.** Every
patch in this session after that point does exactly this. Keep doing it.

### S-02. `host_terminal` is `/bin/sh`, and quoting will bite you

`<(...)` process substitution fails. A `bash -lc '...'` wrapper containing a heredoc with
apostrophes broke the shell and **committed a mangled commit message**, which had to be fixed
with `git commit --amend -F`. **Write messages and SQL to a file first.**

### S-03. Background jobs die in `device_bash`

`nohup ... &` in `device_bash` is killed when the call returns. ~5 minutes were lost polling a
log for a process that had already been reaped. **Use `host_terminal` with `disown` for anything
over ~100 seconds.**

### S-04. The Supabase pooler host does not work here

`aws-0-us-east-1.pooler.supabase.com:5432` -> `FATAL: (ENOTFOUND) tenant/user
postgres.kuklfnapbkmacvwxktbh not found`. Use the direct host
`db.kuklfnapbkmacvwxktbh.supabase.co:5432`. Also `psql: command not found` until
`PATH=/opt/homebrew/bin:$PATH`.

### S-05. `CREATE OR REPLACE` cannot change a function's return type

`get_anti_cheat_stats` went json -> jsonb and needed `DROP FUNCTION IF EXISTS` **inside the same
transaction**. The first apply rolled back cleanly (which is the point of `--single-transaction`).

### S-06. The agent shipped a function that could never run

`fn_ca_dismiss_collusion_pair` wrote `status = 'dismissed'`; the check constraint allows
`open|reviewed|cleared|actioned`. **`tsc`, the whole vitest suite, and every gate passed.** Only
the live probe caught it. **Always probe a new write path against the real constraint.**

### S-07. The agent's first ban function would have destroyed a player's chips

It did `DELETE FROM club_members`. That table carries `chip_balance`, `held_chips`,
`locked_chips`, `promo_balance`, `credit_used`. The probe's first pick held **10,067.64 chips**.
It also referenced `cm.id`, **a column `club_members` does not have** - which is what made the
probe fail loudly enough to force a rethink. **The migration was corrected in place and
re-applied before it was ever committed**, so no broken version exists in history.

### S-08. Local gates are not the whole gate set

`entry-chunk-delta.mjs` is **not** in `all-gates.sh` and caught a genuine first-paint regression
that had already been pushed. **Always run it too.**

### S-09. The full local suite is flaky under machine load

One run reported 11 failures, another 1 - all `userEvent` and git-spawn **timeouts**, all
passing in isolation. Do not chase these. Re-run with the machine idle before believing a
failure. **But do not use this as an excuse to ignore a real failure** - check each one in
isolation before dismissing it.

### S-10. `act()` warnings in component tests

`render()` followed by a `waitFor` that resolves immediately lets the async load settle outside
`act`. Fix: wait for a post-load element first, and wrap `fireEvent` in `await act(async () => {...})`.

### S-11. Tests that assert a string is absent will match your own comments

Five assertions in the Phase 3 suite failed because the explanatory comments named the dead
symbols they were asserting gone. **Assert against call sites** (`supabase.rpc('x'`,
`async fnName(`), not bare tokens.

### S-12. Push rejected non-fast-forward

Autopilot had merged `main` into the branch. **`git merge origin/<branch>` - never rebase.**
Re-ran gates, pushed.

### S-13. The GitHub token cannot read check runs

`gh pr checks` and `.../check-runs` both 403. Use
`gh api "repos/.../actions/runs?branch=..."` and `.../actions/runs/<id>/jobs`. Reading a job's
log via `gh api .../jobs/<id>/logs` works and is the only way to see why CI failed.

### S-14. Approaches deliberately REJECTED

| Rejected                                                         | Why                                                                                           | Chosen instead                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Updating `entry-chunk-baseline.json` to accept the staff modules | Players would pay for operator code before first paint                                        | Split the rail                                 |
| Writing a new definer clawback RPC                               | The platform already had a correct one                                                        | Deleted the dead copy, repointed the UI        |
| Deleting `club_members` on ban                                   | Destroys chips                                                                                | Return the balance and let the operator settle |
| `ON CONFLICT` on `blacklists`                                    | The unique index is **partial** (permanent rows only); a timed ban does not match the arbiter | Explicit lookup-then-branch                    |
| Re-surfacing the 169,519 auto-cleared collusion rows             | The ruling belongs to the detector's owners                                                   | Screen open rows, report `closed_pairs`        |
| `CREATE INDEX CONCURRENTLY`                                      | "One migration = one transaction" forbids it                                                  | Plain `CREATE INDEX` (~20s, ShareLock)         |
| Making "Add Prepaid" read-modify-write the credit limit          | Racy, and semantically wrong                                                                  | Send chips to the agent wallet                 |

---

## 16. Known Defects And Architectural Holes

### Introduced or owned by THIS work

| #    | Priority     | Defect                                                                                                                     | Evidence                                                                | Impact                                                                                             | Fix                                                                                                                                                 | Status                          |
| ---- | ------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| D-01 | ~~CRITICAL~~ | ~~Nothing has merged or published.~~ **RESOLVED 22:05 UTC.**                                                               | Merged as `c22a3bb00`; `build-info.json ca_sha = 71b310c01` contains it | -                                                                                                  | -                                                                                                                                                   | **CLOSED**                      |
| D-02 | HIGH         | The payables tab shows both the true figure and the superseded estimate                                                    | By design, "for one release"                                            | If nobody removes it, the page carries a permanently confusing second number                       | Remove the estimate line and `total_estimate`/`estimate` from the payload one release after publish                                                 | **Deliberate, needs follow-up** |
| D-03 | MEDIUM       | `fn_ca_agent_payables` caps its row list at 200 with no server-side paging                                                 | Migration source, `v_cap constant integer := 200`                       | A club with >200 agents sees a truncated table (totals are still correct and the UI says so)       | Add cursor paging if any club exceeds it                                                                                                            | Open                            |
| D-04 | MEDIUM       | Payables is still ~1.7s cold                                                                                               | Measured                                                                | Slow tab open                                                                                      | Will improve when autovacuum sets the visibility map (1,278 heap fetches remain). Re-measure.                                                       | Open                            |
| D-05 | MEDIUM       | **No page in this work has been opened in a browser.**                                                                     | No manual verification was performed                                    | Layout, responsive behaviour and real interaction are unverified                                   | Walk every changed page at 375px and desktop after publish                                                                                          | **Open - do this**              |
| D-06 | MEDIUM       | **No down-migrations. Rollback never tested.**                                                                             | No `*_down.sql` exists                                                  | A bad definer function cannot be reverted by migration                                             | The functions are `CREATE OR REPLACE`, so a forward fix is the path. `20260903210000` **dropped** the old index - reverting it means recreating it. | Open                            |
| D-07 | LOW          | `ban` sends a hardcoded reason ("Banned from the agent network console")                                                   | `AgentManagementPage`                                                   | The operator cannot say why                                                                        | Add a reason field to the confirm dialog                                                                                                            | Open                            |
| D-08 | LOW          | `fn_ca_ban_club_player` never sets a `p_expires_at` from this UI                                                           | Same                                                                    | No timed bans from the agent console                                                               | Add an expiry control                                                                                                                               | Open                            |
| D-09 | LOW          | **Migration filename version != recorded version** for Phase 1: file `20260903160000_...` is recorded as `20260903152100`. | Live query of `supabase_migrations.schema_migrations`                   | The gate passes (matches by name), but a future tool that matches by version will report a phantom | Leave alone unless a gate complains; **do not renumber an applied migration**                                                                       | **FLAGGED, not fixed**          |

### Pre-existing, confirmed, NOT yet fixed (these are Phases 4-8)

| #    | Priority     | Defect                                                                                                                                                                                                                                                                                                                     | Evidence             | Phase         |
| ---- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------- |
| P-01 | **CRITICAL** | **"Humans Only" strips 416 of 417 players** from the leaderboard, the attribution denominator and the CSV export - a persisted localStorage toggle that filters horses out of a total. **Direct CLAUDE.md 10.5 violation.** Also a silent no-op below owner/co_owner/admin because `fn_can_see_horse_flag` masks the flag. | Plan doc Section 6   | 4             |
| P-02 | **CRITICAL** | **Financials computes four headline numbers from the OLDEST 5,000 rows.** Rake reads **4.6% of true**.                                                                                                                                                                                                                     | Plan doc Section 8   | 6             |
| P-03 | **CRITICAL** | Settlement page **writes with the raw route param** and **hardcodes receipt status "paid"**.                                                                                                                                                                                                                               | Plan doc Section 9   | 7             |
| P-04 | HIGH         | Dashboard Tables tab fetches the newest 50 tables; **zero of the club's 226 live tables are in that 50**. The header says "227 Active Tables" above 50 dead rows, and `liveTableCount`/`seatedAcrossTables` are computed over the wrong 50.                                                                                | Plan doc Section 6   | 4             |
| P-05 | HIGH         | `ca_club_tournaments` **ignores `p_limit`** (the LIMIT sits after `jsonb_agg`) - 439 unvirtualized rows / 97KB for a request of 25.                                                                                                                                                                                        | Plan doc Section 6   | 4             |
| P-06 | HIGH         | **Revenue and Tournaments tabs are visible to every plain member** - `ca_can_view_club` is satisfied by any non-banned membership and neither tab has a client gate.                                                                                                                                                       | Plan doc Section 6   | 4             |
| P-07 | HIGH         | Promo vault grants **deliver nothing to the player**.                                                                                                                                                                                                                                                                      | Plan doc Section 10  | 8             |
| P-08 | HIGH         | Club rules save **reports success after RLS refused it** - the same 204 pattern.                                                                                                                                                                                                                                           | Plan doc Section 10  | 8             |
| P-09 | MEDIUM       | `ClubMemberManagement` swallows a failed read into an empty list with no error, and offers an **unconfirmed hard DELETE** of a membership behind a bare glyph. Also prints an avatar URL as text; staggers row visibility by an index into the **unfiltered** array, so searching leaves rows at `opacity: 0`.             | Plan doc Section 6   | 4             |
| P-10 | MEDIUM       | "Seated Now" counts seat rows, not people (698 vs 221). Phase 1's overview already counts people; **this is where the old number still lives**.                                                                                                                                                                            | Plan doc Section 6   | 4             |
| P-11 | MEDIUM       | Time Range filter is half-wired - `ca_club_dashboard_stats` takes no date argument, so six metric cards and the 14-day chart never change; Tournaments fixed at 30 days; Revenue caps at 90 while the heading says "all time".                                                                                             | Plan doc Section 6   | 4             |
| P-12 | MEDIUM       | The leaderboard **sorts a pre-truncated set** - `ca_club_top_players` orders by profit and takes 100; choosing Hands or Win Rate re-sorts those 100.                                                                                                                                                                       | Plan doc Section 6   | 4             |
| P-13 | MEDIUM       | `ca_club_dashboard_stats` is called **twice on every mount**.                                                                                                                                                                                                                                                              | Plan doc Section 6   | 4             |
| P-14 | MEDIUM       | The insurance gate never fires (`ca_club_revenue` always returns an object, so `revenue.insurance ?` is always truthy).                                                                                                                                                                                                    | Plan doc Section 6   | 4             |
| P-15 | MEDIUM       | Per-player rake is **always 0** for a non-union club.                                                                                                                                                                                                                                                                      | Plan doc Section 8   | 6             |
| P-16 | LOW          | `bbj_rake_enabled`, `spins_preseed_amount`, `spins_wallet_funding` are settings **nothing reads**.                                                                                                                                                                                                                         | Plan doc Section 10  | 8             |
| P-17 | LOW          | `AgentService.assignPlayerToAgent` / `promoteToAgent` / `selfTransfer` are dead code; the first **returns `true` after a guaranteed no-op**.                                                                                                                                                                               | This session's audit | opportunistic |
| P-18 | LOW          | Uncapped/unnoticed limits across the agent pages (500 agents, 50 commissions, 100 transactions).                                                                                                                                                                                                                           | This session's audit | opportunistic |
| P-19 | LOW          | Empty icon-wrapper spans with stray leading spaces across both agent pages.                                                                                                                                                                                                                                                | This session's audit | opportunistic |
| P-20 | LOW          | `AgentRakeService` opens a new realtime channel per call (randomised channel name).                                                                                                                                                                                                                                        | This session's audit | opportunistic |

### Infrastructure (not this work, but blocking or noisy)

| #    | Priority | Issue                                                                                                                                                                                             | Evidence                |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| I-01 | **HIGH** | **`src/engine/CryptoRandom.test.ts` is statistically flaky** - a chi-square uniformity assertion that fails on unlucky draws (33.43 vs a 32.91 threshold). It has failed a CI run on this branch. | CI job log 100816515939 |
| I-02 | HIGH     | **`server/src/engine/InsuranceRitExclusivity.test.ts` times out under CI load.** Passes locally in 7.09s.                                                                                         | CI job log 100746920854 |
| I-03 | MEDIUM   | **Sentry release token appears expired** - `sentry-cli releases new club-arena@1.0.1` returns **403**.                                                                                            | CI job log 100746920905 |
| I-04 | LOW      | The `GITHUB_TOKEN` in the local `.env` lacks `checks:read`.                                                                                                                                       | `gh pr checks` 403      |
| I-05 | LOW      | CI runners have a significant queue (runs sat `queued` for 20-30 minutes).                                                                                                                        | Observed repeatedly     |

---

## 17. Security, Secrets, And Credentials

**No secret values appear in this document, in any commit, or in any log that was captured.**

### Environment variable NAMES (from `/Users/smarter.poker/Documents/club-arena/.env`)

`TWILIO_AUTH_TOKEN`, `SENTRY_AUTH_TOKEN`, `VERCEL_TOKEN`, `GITHUB_TOKEN`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `CA_ORIGIN_URL`,
`CA_ORIGIN_ROOT`, `HETZNER_CUSTOMER_ID`, `HETZNER_EMAIL`, `HETZNER_PASSWORD`,
`HETZNER_LOGIN_USERNAME`, `HETZNER_LOGIN_PASSWORD`, `HETZNER_SERVER_IP`,
`HETZNER_TOKEN_SMARTER_POKER`, `HETZNER_TOKEN_DEFAULT`, `HETZNER_SSH_PUBLIC_KEY`,
`HETZNER_SSH_PRIVATE_KEY`.

`.env.example` in the worktree additionally names `VITE_ANTIGRAVITY_ENABLED`, `VITE_APP_ENV`,
`VITE_USE_ENGINE_WS`, `SUPABASE_ACCESS_TOKEN`, `MASTERY_SEAL_SECRET`, `VITE_SENTRY_DSN`,
`SENTRY_ORG`, `SENTRY_PROJECT`, `VITE_APP_VERSION`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`.

### Setup the next agent needs

- **The worktree has no `.env`.** For the DB/CI gates:
  ```
  set -a; . "$HOME/Documents/club-arena/.env"; set +a
  export SUPABASE_URL="$VITE_SUPABASE_URL"     # the gates want the un-prefixed name
  export PATH="/opt/homebrew/bin:$PATH"        # for psql
  ```
- **The `HETZNER_*` and `VERCEL_TOKEN` credentials must not be used by an agent.** Deployment is
  the publisher workflow's job. Their presence in `.env` is not authorisation.

### Security notes

- **No secret was exposed.** Every command that sourced `.env` printed only variable _names_.
  The one `git remote -v` output was piped through `sed "s#//.*@#//***@#"`; it is an SSH remote
  with no embedded credential anyway.
- **Missing/expired:** the Sentry release token (I-03) and `checks:read` on the GitHub token
  (I-04).
- **A permission hole was CLOSED by this work:** before Phase 1, any plain club member could
  open the anti-cheat / collusion console by typing the URL, because `anti-cheat` was absent
  from `OPERATION_SUFFIXES` and the guard therefore checked nothing.

---

## 18. Database, Migration, And Seed Status

- **Provider:** Supabase Postgres, project `kuklfnapbkmacvwxktbh`. **There is no local database.
  All work was done against production**, per the repo's DDL policy, using rolled-back
  transactions for verification.
- **No seed scripts were written or run.** No seed data was created. No production row was
  permanently modified by this session - **every write probe was rolled back**.

### Migrations added (all APPLIED and RECORDED - verified by live query)

| Version          | Name                                            | Recorded as                     | Objects                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260903160000` | `the_operations_page_reads_the_club_it_governs` | **`20260903152100`** (see D-09) | `ca_club_operations_overview`                                                                                                                                                                                                                                                                                               |
| `20260903170000` | `an_integrity_decision_is_written_down`         | `20260903170000`                | `fn_ca_can_review_integrity`, `fn_club_anti_cheat_flags`, `fn_review_anti_cheat_flag`, `get_anti_cheat_stats` (dropped + recreated json->jsonb), `detect_collusion_pairs`, `fn_ca_dismiss_collusion_pair`, `fn_dispute_start_review`, `fn_dispute_escalate`, `idx_collusion_tracking_window`, `idx_collusion_tracking_pair` |
| `20260903180000` | `a_cleared_pair_stays_cleared`                  | `20260903180000`                | replaces `detect_collusion_pairs`, `fn_ca_dismiss_collusion_pair`                                                                                                                                                                                                                                                           |
| `20260903200000` | `an_agent_payout_is_a_record`                   | `20260903200000`                | `fn_ca_can_manage_agents`, `fn_ca_agent_payables`, `fn_ca_ban_club_player`                                                                                                                                                                                                                                                  |
| `20260903210000` | `the_payables_read_is_index_only`               | `20260903210000`                | **DROPS and recreates** `agent_commissions_unsettled_idx` with `INCLUDE (amount, created_at)`; `ANALYZE agent_commissions`                                                                                                                                                                                                  |

**All ten functions verified live:** `SECURITY DEFINER = true`, `authenticated` EXECUTE = true,
`anon` EXECUTE = false.

### Version-collision warning

`20260903190000` was taken by another team on the same day
(`stats_page_money_is_exact_and_live`). The gate `check-new-migration-version-collisions`
exists and passed. **Several teams ship migrations into this database daily - always pick a
version above the highest recorded one and run that gate.**

### Production-data risks

- `20260903210000` **dropped an existing index** before recreating it. During the ~20 second
  build, `CREATE INDEX` held a `ShareLock` on `agent_commissions`, **queueing (not failing)
  commission inserts**. This was accepted deliberately and is documented in the migration.
- **No backup was taken.** The changes are additive functions plus one index swap. If the next
  agent does anything destructive, take one first.
- `ANALYZE public.agent_commissions` was run on a 925MB table. Harmless.

### Row-level security touched

**None.** No RLS policy was created, altered or dropped by this work. Every access change went
through `SECURITY DEFINER` functions with explicit `REVOKE`/`GRANT`.

---

## 19. Current Blockers And Decision Points

### B-01. RESOLVED - CI went green, and the work merged and published

**Status at 22:05 UTC: no longer blocking.** The third CI run on `8f906f778` passed with no
change made; autopilot merged PR #2853 as `c22a3bb00` and the publisher shipped it. **The two
flakes below are NOT fixed and will be met again** - they are tracked as I-01 and I-02. The
original analysis is kept for that reason.

#### Original analysis (kept - these flakes are still latent)

- **Was blocking:** PR #2853 merging, therefore publishing, therefore Phase 4 under Dan's gate.
- **Evidence:** two failed `CI  -  Build & Type Safety` runs; `CryptoRandom.test.ts` chi-square
  assertion (33.43 vs 32.91) and `InsuranceRitExclusivity.test.ts` timeout. Both are in the
  `Server Engine (typecheck + tests)` job. Both pass locally.
- **Type:** technical, but **fixing them touches another team's engine code**.
- **Options:**
  1. **Wait and let it re-run.** Cost: time, and it may flake again. _(Recommended first.)_
  2. Re-run the failed job. **Requires `actions:write` the local token appears to lack.**
  3. Widen the `CryptoRandom` chi-square threshold or seed the RNG in test. **Correct fix,
     but it is engine code owned by another programme** - would need Dan's or that team's
     agreement, and a separate commit.
  4. Ask Dan to merge manually. **Requires Dan's authority.**
- **Recommendation:** option 1, then 3 (as its own commit and PR, clearly labelled as a test-
  stability fix), then 4.

### B-02. RESOLVED - phases 1-3 are published, so Dan's gate is satisfied

- Dan's standing rule is _"make sure that everything has been fully pushed and published before
  moving onto the next phase"_. Dan also said **"PROCEED TO PHASE 3"** while nothing had
  published, which the agent took as an override for that phase.
- **Decision required:** may the next agent start **Phase 4** while phases 1-3 are still
  unpublished?
- **Consequences:** proceeding grows the un-merged branch (more surface for a conflict, a bigger
  eventual review); waiting stalls the programme on a runner queue nobody controls.
- **Resolved 22:05 UTC:** phases 1-3 are published, so Dan's condition ("fully pushed and
  published before moving onto the next phase") **is met** and Phase 4 may begin. No decision is
  required from Dan on this point.

### B-03. The "estimate beside the truth" is a one-release measure - **NEEDS A DATE**

- The payables tab deliberately shows the superseded number. **Who removes it, and when?**
- **Recommendation:** remove it in the first commit after this work publishes; add it to the
  plan doc as a tracked item.

### B-04. `AgentService` dead code that lies - **AGENT'S CALL, LOW RISK**

- `assignPlayerToAgent` returns `true` after a write that RLS guarantees is a no-op. Zero
  callers. **Recommendation:** delete it and its two dead siblings opportunistically in Phase 4,
  in their own commit.

---

## 20. Remaining Work

### CRITICAL

1. ~~Get PR #2853 green and merged~~ **DONE 22:05 UTC** - merged as `c22a3bb00`, published in
   `ca_sha 71b310c01`.
2. **Phase 4 - P-01:** remove the "Humans Only" horse filter from every total, export and
   denominator (CLAUDE.md 10.5 violation).
3. **Phase 6 - P-02:** Financials headline numbers read the oldest 5,000 rows; rake shows 4.6%
   of true.
4. **Phase 7 - P-03:** settlement page writes with a raw route param and hardcodes receipt
   status `"paid"`.

### HIGH

5. **Phase 4:** Tables tab (P-04), tournaments `p_limit` (P-05), Revenue/Tournaments permission
   leak (P-06).
6. **Phase 8:** promo vault grants deliver nothing (P-07); rules save reports a refused write
   (P-08).
7. Manual browser verification of every page changed in Phases 1-3, at 375px and desktop (D-05).
8. Decide and act on the CI flakes (I-01, I-02) and the Sentry token (I-03).

### MEDIUM

9. **Phase 4:** member management (P-09), Seated Now (P-10), time range (P-11), leaderboard
   sort (P-12), double fetch (P-13), insurance gate (P-14).
10. **Phase 5:** players and player records - see plan doc Section 7.
11. **Phase 6:** per-player rake always 0 for non-union clubs (P-15).
12. Remove the superseded payables estimate (D-02).
13. Re-measure payables cold time after autovacuum (D-04).
14. Decide the rollback story for definer migrations (D-06).

### LOW

15. Ban reason + expiry controls (D-07, D-08).
16. Delete `AgentService` dead code (P-17).
17. Cap notices across the agent pages (P-18).
18. Empty icon wrappers (P-19).
19. `AgentRakeService` channel reuse (P-20).
20. Settings nothing reads (P-16).

### OPTIONAL ENHANCEMENT

21. Server-side paging for `fn_ca_agent_payables` beyond 200 agents (D-03).
22. A visual-regression harness (none exists).
23. Add `entry-chunk-delta.mjs` into `all-gates.sh` so nobody else misses it.

---

## 21. Prioritized Next-Phase Execution Plan

### Phase 0 - Recover And Verify Current State _(do this first, always)_

- **Objective:** know exactly where things stand before touching anything.
- **Prerequisites:** none.
- **Steps:** run the checklist in Section 22.
- **Completion criteria:** you can state (a) the branch HEAD, (b) whether the worktree is clean,
  (c) whether PR #2853 has merged, (d) what `build-info.json` reports.
- **Risks:** none. **Checkpoint:** none needed.

### Phase 1 - Protect Completed Work

- **Objective:** do not damage phases 1-3.
- **Inspect:** `git log --oneline origin/main..HEAD`, `git status`.
- **Rules:**
  - **Never** edit an applied migration file. Ship a correction as a new migration.
  - **Never** touch `docs/HANDOFF_CURRENT_STATE.md`.
  - **Never** re-inline the overview hook into `ClubOperationsRail.tsx`.
  - **Never** reintroduce a `.update()` on `anti_cheat_flags`, `disputes`, `chip_transactions`,
    `agents`, or `wallets` from the browser.
  - **Never** add an `is_horse` filter to a count, export or payout.
- **Completion criteria:** the 273 new tests still pass.
- **Checkpoint:** none - this is a constraint, not a task.

### Phase 2 - Unblock The Merge

- **Objective:** phases 1-3 in production.
- **Prerequisites:** Phase 0.
- **Inspect:** `gh api "repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs?branch=feat/club-operations-full-upgrade&per_page=6"`; if a run failed,
  `gh api ".../actions/runs/<id>/jobs"` then `gh api ".../actions/jobs/<id>/logs"`.
- **Changes:** likely none in this repo. If the `CryptoRandom` flake recurs, propose a separate
  PR that seeds the RNG or widens the threshold - **do not fold it into this branch**.
- **Tests:** none new.
- **Completion criteria:** `build-info.json` `ca_sha` equals the squashed merge commit.
- **Risks:** touching another team's engine tests without agreement.
- **Checkpoint:** no commit on this branch unless a real fix is needed.

### Phase 3 - Manual Verification Of What Already Shipped

- **Objective:** close D-05. **This has never been done and it is the largest unverified area.**
- **Prerequisites:** Phase 2 (published).
- **Inspect in a browser** at 375px and desktop:
  `/clubs/deep-stack-society-11192/operations`, `/finance`, `/control`, `/anti-cheat`,
  `/reports`, `/disputes`, `/blacklist`, `/agents` (all tabs, especially Payouts and Players).
- **Completion criteria:** every page renders, badges match the RPC, no horizontal page scroll
  at 375px, no console errors.
- **Risks:** discovering a layout defect that needs a Phase 3.5 commit.
- **Checkpoint:** commit any fixes as `fix(club-operations): <what the browser showed>`.

### Phase 4 - The Club Dashboard _(the next build phase)_

- **Objective:** the dashboard tells the truth.
- **Prerequisites:** Phases 0-2; ideally 3.
- **Inspect:** `src/pages/club/ClubDashboard.tsx`, `src/components/club/ClubStatsCards.tsx`,
  `src/components/admin/ClubMemberManagement.tsx`, and the RPCs `ca_club_dashboard_stats`,
  `ca_club_top_players`, `ca_club_tournaments`, `ca_club_revenue`, `ca_can_view_club`,
  `fn_can_see_horse_flag`. **Read plan doc Section 6 first - every defect is already confirmed with
  evidence.**
- **Changes:** remove the horse filter (P-01); fix the Tables query to select live tables
  (P-04); fix `p_limit` in `ca_club_tournaments` (P-05); gate Revenue/Tournaments (P-06); the
  medium items P-09 to P-14.
- **Tests:** a new `tests/...` file in the house style; mount the dashboard; assert the horse
  filter is gone; assert the tables query is not `created_at DESC LIMIT 50`; assert the
  permission gate.
- **Live verification:** probe `ca_club_tournaments` for its true row count vs `p_limit`; probe
  the leaderboard with and without the horse filter and record both numbers; confirm a plain
  member is refused Revenue.
- **Completion criteria:** all-gates + entry-chunk + 14 DB gates + lint green; live probe
  recorded in the commit message; changelog written.
- **Risks:** `ca_club_dashboard_stats` is shared with other surfaces - changing its shape may
  break them. **Check callers before altering a return shape.**
- **Checkpoint:** one commit, `feat(club-operations): the dashboard counts what is there`.

### Phases 5-8

Follow the plan doc Section 7 (Players), Section 8 (Finance truth), Section 9 (Money movement), Section 10 (Club control).
Each is already specified with confirmed defects. **Money movement (Phase 7) is the highest-risk
phase** - re-read CLAUDE.md Section 10.9 and `.agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md`
before starting it.

---

## 22. Exact First Actions For The Next Agent

Run these in order. Everything below is a confirmed path or command.

```bash
# 1. Get to the worktree (this is a git WORKTREE, not the main clone)
cd /Users/smarter.poker/Documents/.agent-trees/club-arena/ops-upgrade

# 2. Confirm identity and cleanliness  (use host_terminal, NOT device_bash - device_bash cannot run git)
git rev-parse --show-toplevel
git branch --show-current          # expect: feat/club-operations-full-upgrade
git status --porcelain             # expect: EMPTY
git log --oneline -1               # expect: 8f906f778 or later
git fetch origin
git rev-list --left-right --count origin/feat/club-operations-full-upgrade...HEAD   # expect: 0  0

# 3. Has it merged and published?
git log --oneline -1 origin/main
curl -s https://smarter.poker/hub/club-arena/build-info.json

# 4. What is CI doing?
export GH_TOKEN=$(grep -m1 "^GITHUB_TOKEN=" /Users/smarter.poker/Documents/club-arena/.env | cut -d= -f2- | tr -d '"')
gh api "repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs?branch=feat/club-operations-full-upgrade&per_page=6" \
  --jq '.workflow_runs[] | "\(.status)/\(.conclusion // "running") \(.name) sha=\(.head_sha[0:9])"'
gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/2853 \
  --jq '"state=\(.state) merged=\(.merged) mergeable_state=\(.mergeable_state)"'
```

**5. Read, in this order:**

1.  `docs/HANDOFF-2026-09-03-club-operations-upgrade.md` (this file)
2.  `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md` - especially Section 6 (Phase 4)
3.  `CLAUDE.md` Section 1.1, Section 1.3, Section 1.4, Section 2, Section 10.5, Section 10.7, Section 10.8, Section 10.9, Section 11.5
4.  `.agent/architecture/deploy-paths.md`
5.  `docs/changelog/2026-09-03-club-operations-phase-3-the-agent-network.md`

**6. Verify the completed work still stands:**

```bash
bash -lc 'npx vitest run \
  tests/unit/clubOperationsRegistryIntegrity.test.ts \
  tests/unit/clubOperationsOverviewContract.test.ts \
  tests/components/club-operations-page.test.tsx \
  tests/components/club-operations-surfaces.test.tsx \
  tests/unit/integrityDecisionsAreWrittenDown.test.ts \
  tests/components/anti-cheat-console.test.tsx \
  tests/unit/theAgentNetworkReachesSomething.test.ts'
# expect: Tests 273 passed (273)
```

**7. DO NOT MODIFY:**

- `docs/HANDOFF_CURRENT_STATE.md` - another programme owns it
- Any file under `supabase/migrations/` dated `20260903160000`-`20260903210000` - all applied
- `src/components/navigation/ClubOperationsRail.tsx` - do not add anything that queries
- `.agent/protected-commits.json`

**8. Resume at:** **Phase 4, the club dashboard.** B-01 and B-02 are both resolved: phases 1-3
merged as `c22a3bb00` and are live. Do the manual browser pass first (D-05, now possible and
still never done), then start Phase 4 with the horse filter (P-01), a standing violation of a
BINDING rule.

**Start a fresh branch off `main`** rather than reusing `feat/club-operations-full-upgrade`:

```bash
git fetch origin main
git checkout -b feat/club-operations-phase-4 origin/main
```

---

## 23. Acceptance Criteria

### For the current phase (Phases 1-3) to be truly "done"

- [x] PR #2853 merged into `main` - squash commit `c22a3bb00`. **VERIFIED 22:05 UTC.**
- [x] `build-info.json` reports a `ca_sha` that contains this work - `71b310c01`, with
      `c22a3bb00` a verified ancestor. **VERIFIED 22:05 UTC.**
- [ ] All 273 new tests pass on `main`.
- [ ] `all-gates.sh` **and** `entry-chunk-delta.mjs` **and** the 14 DB/CI gates **and** lint are
      green on `main`.
- [ ] Every page changed in phases 1-3 has been **opened in a browser** at 375px and desktop
      with no console errors and no horizontal page scroll. **(D-05 - not yet done.)**
- [ ] An operator pressing "Submit Review", "Start Review", "Escalate", "Ban Player",
      "Take Back", "Set Credit Line", "Send Prepaid Chips" or "Reduce Credit Line" either sees
      the effect or sees an honest refusal. Never a false success.
- [ ] The payouts tab total equals `SELECT sum(amount) FROM agent_commissions WHERE club_id = $1
    AND settled_at IS NULL`.
- [ ] No count, export or payout anywhere in the workspace filters on whether an account is
      house-run.
- [ ] `git status` clean; nothing unpushed.

### For the whole 8-phase programme

- **Functional:** every one of the 26 routes loads, is permission-gated by the registry, and has
  no control that reports success without a write.
- **Data:** every number shown is traceable to rows, not to arithmetic over a truncated or
  stale set.
- **Financial:** every money control either moves money through a granted, definer, idempotent
  RPC, or is removed. No client write to `wallets`, `agents`, or `chip_transactions`.
- **Visual:** mobile-first at 375px; wide content scrolls in its own container; Title Case; no
  em dashes; no emoji.
- **Accessibility:** landmarks correct, `aria-current` on the active rail item, no unlabelled
  controls, no zero-content buttons.
- **Performance:** no operator read over ~2s cold; nothing new in the entry chunk.
- **Testing:** every fixed defect has a test that fails if it returns; every new definer function
  is probed live as the real user in a rolled-back transaction.
- **Migration safety:** one migration per transaction, applied _and_ recorded, no version
  collision, never edited after applying.
- **Git:** clean tree, one logical commit per workstream, a changelog per commit.
- **Deployment:** verified through `build-info.json`, never by hand.

---

## 24. Recommended Commit Strategy

Do not mix workstreams. Suggested sequence for the remaining work:

| #   | Suggested message                                                                  | Includes                                                                                                                 | Tests required first                                      |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | `fix(engine-tests): the shuffle uniformity check stops failing on an unlucky draw` | `src/engine/CryptoRandom.test.ts` only. **Separate branch/PR - it is another programme's code.**                         | that file alone                                           |
| 2   | `fix(club-operations): what the browser showed`                                    | Only layout/console fixes found in the manual pass. Skip if clean.                                                       | all-gates + entry-chunk                                   |
| 3   | `feat(club-operations): the dashboard counts what is there`                        | Phase 4: P-01, P-04, P-05, P-06, P-09..P-14 + migration if the RPCs change + new test file + changelog + plan doc update | all-gates + entry-chunk + 14 DB gates + lint + live probe |
| 4   | `fix(club-operations): the verification pass on phase 4`                           | Whatever probing phase 4 finds in phase 4's own work. **Budget for this - it has happened every single phase.**          | same                                                      |
| 5   | `feat(club-operations): a player record is a record`                               | Phase 5                                                                                                                  | same                                                      |
| 6   | `feat(club-operations): the finance numbers are the finance numbers`               | Phase 6 (P-02, P-15)                                                                                                     | same                                                      |
| 7   | `feat(club-operations): money moves once and says so`                              | Phase 7 (P-03). **Highest risk - read Section 10.9 and the money-ledger canon first.**                                   | same + a rolled-back money probe                          |
| 8   | `feat(club-operations): club control writes what it says`                          | Phase 8 (P-07, P-08, P-16)                                                                                               | same                                                      |
| 9   | `chore(club-operations): the superseded payables estimate comes down`              | D-02                                                                                                                     | all-gates                                                 |

Every commit message in this repo follows the house voice: **what was wrong, with the measured
evidence, then what changed.** End with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the new session URL>
```

---

## 25. Final Continuation Summary

**Exact stopping point.** Phases 1, 2 and 3 of 8 are **built, tested (273 new cases, all
passing), merged and published**. PR #2853 was squash-merged as **`c22a3bb00`** on `main` at
~22:03 UTC and the publisher shipped it; `c22a3bb00` is a verified ancestor of the live
`ca_sha = 71b310c01`. All five migrations are applied and recorded in production. The branch
`feat/club-operations-full-upgrade` sits at `8f906f778`, clean, fully contained in `main`, and
can be abandoned.

**Work on first:** the manual browser pass (D-05). **No page in this work has ever been opened in
a browser**, and it is now live, so this is both possible and overdue. Then **Phase 4, the club
dashboard**, on a fresh branch off `main`, starting with P-01, the "Humans Only" filter that
strips 416 of 417 players out of a total in direct violation of CLAUDE.md 10.5.

**Most important locked requirements:** horses are players and are never filtered out of a count
(CLAUDE.md 10.5); a seat is never closed outside a cash-out (11.5); no control may report success
without a verified write; push a branch and stop - never touch Hetzner, Vercel, or the World Hub;
never edit an applied migration.

**Greatest technical risk:** the systemic 204/zero-rows/no-error pattern. It has appeared in every
phase so far and `tsc` and the full test suite catch none of it. Only probing the live database as
the real user does.

**Greatest visual risk:** **no page in this work has ever been opened in a browser.** All visual
and responsive behaviour across three phases is unverified.

**Greatest data-integrity risk:** money paths in Phases 6 and 7 - a settlement page that writes
with a raw route param and hardcodes a receipt as `"paid"` (P-03), and financial headline numbers
computed from the oldest 5,000 rows (P-02). Neither is fixed. Also latent: `club_members` rows
carry chips, and anything that deletes one destroys them.

**Decisions still requiring Dan:** (1) is it acceptable to touch another programme's engine tests
to stabilise the two known CI flakes, I-01 and I-02, which cost this branch two failed runs
(B-01, option 3); (2) when does the superseded payables estimate come down (B-03). Dan's
per-phase publish gate is **satisfied**, so B-02 is resolved.

**How to continue without restarting discovery.** Everything discovered is written down in three
places and none of it needs rediscovering: this handoff holds the state, the decisions and the
traps; `docs/club-operations/OPERATIONS-UPGRADE-PLAN.md` holds the 26-route inventory and every
confirmed defect for Phases 4-8 with file:line evidence; and the three changelogs plus the six
commit messages hold the reasoning and the measured figures behind every change already shipped.
Run the Phase 0 checklist in Section 22, read the plan doc's Section 6, and start building Phase 4 - the audit
for it is already complete, so the next agent's first line of code can be a fix rather than an
investigation.
