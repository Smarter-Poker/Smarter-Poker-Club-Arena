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

### 1.1.5 SERVER-SIDE PROTECTION (APPLIED - this section is history)

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

VERIFIED AGAINST THE LIVE API 2026-08-28, because two other places in this repo
say the opposite and they are the stale ones. Ruleset `main protection`
(id 21163380) on `refs/heads/main` is `enforcement: active`, with
`bypass_actors: []` - nobody, including a repo admin, merges around it. Its
rules are `deletion`, `non_fast_forward`, `pull_request` (squash only, 0
approvals) and `required_status_checks`:

    TypeScript Check
    Client Unit Tests (vitest)
    Server Engine (typecheck + tests)
    Production Build
    CSS Beat E2E (multi-table + animations)
    Silent Revert Guard

So: a direct push to main is refused, a red check cannot be merged, and
`ci.yml`'s `if: github.event_name == 'pull_request'` gating is SAFE precisely
because the ruleset makes the pull-request path the only path.

Two documents disagree with the API and are wrong. Believe the API.

- Section 1.1.5 above is titled "prepared, not yet active". It is active.
- `.husky/pre-push` check 0 says "making the repos private ... silently
  disabled required status checks and rulesets ... nothing enforces it
  server-side any more". That was true when it was written and is not true
  now.

THE SKIPPED-CHECK GAP: CLOSED, and this paragraph is the correction (verified
against ci.yml and the live API 2026-08-31). `ci.yml` gates `unit`, `server`
and `build` behind the `changes` job, and A RULESET COUNTS A SKIPPED REQUIRED
CHECK AS SATISFIED - so the shape of the danger is real and worth knowing. But
all three jobs now carry

    always() && github.event_name == 'pull_request' &&
    (needs.changes.result != 'success' || ...)

so an undetermined diff RUNS them rather than skipping them, and `changes`
itself fails open: three retries, then "run everything" if the file list is
still unavailable, and any change to package.json / vite / vitest / tsconfig /
.npmrc / .nvmrc / ci.yml is treated as touching everything. `typecheck` and
`stub_gate` are ungated entirely.

This text used to say the gap was live. It was describing the 2026-08-23
incident, which the `always()` guards above were added to fix - the words
outlived the bug and told every agent since that CI could not be trusted. The
remaining skips are the correct kind: `changes` succeeded and said, truthfully,
that server/\*\* was not touched.

One latent hole in that machinery WAS still open and is now closed too: the
changed-file call asked for `per_page=300`, and the GitHub API caps per_page at
100 silently, so a pull request over 100 files would have been classified on a
truncated list. It uses `--paginate` now. No pull request here has exceeded 19
files, so nothing was ever misclassified in practice.

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

### Production DDL policy (added 2026-08-31 after the PGRST002 503 outage — BINDING)

Every DDL statement (CREATE/ALTER of tables, views, functions, types, triggers,
COMMENT) fires Supabase's `pgrst_ddl_watch` event trigger, which makes PostgREST
reload its entire schema cache. On this database (~970 relations, ~2,700
functions) one reload takes **~28 seconds**. On 2026-08-31 the `authenticator`
role's default 8s statement_timeout killed that reload query every time, and the
resulting PGRST002 retry loop 503'd up to 28% of live traffic (seating and
dealing included). Fixed by the `fix_pgrst002_schema_cache_timeout` migration:
`authenticator` statement_timeout is now 5min (service_role pinned to its
previous effective 8s). Do not revert either setting in any "hardening" pass.

Rules for every agent working this project:

1. Wrap ALL DDL for one change in a SINGLE transaction (one migration = one
   BEGIN/COMMIT). Postgres coalesces the reload NOTIFYs inside one transaction;
   ten separate statements outside a transaction = up to ten 28-second reloads.
2. Do not apply migrations in a retry loop. If a migration fails, read the
   error; re-running the whole batch every minute multiplies reloads.
3. No DDL probes against production (CREATE TEMP TABLE is fine — pg_temp is
   filtered — but CREATE/DROP INDEX cycles, scratch tables, or CREATE OR
   REPLACE FUNCTION as a "test" are not).
4. Batch related migrations. During US daytime peak, prefer one consolidated
   apply over many small ones.
5. GRANT/REVOKE do NOT trigger reloads (not in pgrst_ddl_watch's list) — runtime
   grant churn is a non-issue for this outage class.
6. Client resilience for the residual window lives in
   `src/lib/pgrstRetryFetch.ts` (web) and the `global.fetch` wrapper in
   `server/src/services/supabase/client.ts` (engine): both retry only
   pre-execution 503s (PGRST001/002/003). Do not remove them, and do not
   "extend" them to retry other 5xx — replaying an executed write is a
   money-integrity hazard.

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

---

## 10.5 HORSES ARE PLAYERS (Dan, 2026-08-27, BINDING — NO EXCEPTIONS)

**Dan, verbatim: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY
MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"**

This is a HARD LAW. It outranks any optimisation, any convenience, and any
assumption you arrive with. If you are writing a filter, a report, a payout, a
rule, a limit, a stat, a sweep or a guard, and you find yourself typing
`is_horse` in order to leave horses OUT of something a human would get — stop.
You are writing a bug.

### The rule

A horse pays the same buy-in, out of the same club wallet, through the same
RPCs, and sits in the same seat as anybody else. Therefore a horse:

- **EARNS** everything a human earns from the same action — VIP points, agent
  and super-agent commissions, `player_stats`, rakeback basis, leaderboard
  position, achievements, anything downstream of play or of rake;
- **IS PAID** everything a human is paid — prizes, bounties, refunds,
  shortfall back-pay, jackpots. Never "skip the horses" on a repayment;
- **IS SUBJECT TO** every rule a human is subject to — nit/VPIP eviction,
  limits, guards, integrity checks;
- **COUNTS** everywhere a human counts — player counts, engine provisioning,
  table liveness, conservation and reconciliation totals;
- **IS NEVER** silently filtered out of a report, a total, or a ledger.

### What is still allowed

`is_horse` remains legitimate for exactly two things:

1. **Identification** — surfacing the flag as DATA (a badge, a column, a
   roster field), or the horse-specific plumbing that creates, seats, funds
   and steers the fleet (`fn_register_horse_for_tournament`,
   `fn_seed_horses_to_floor`, `autoRebuyHorse`, HorseLogic, and so on). Those
   spawn and drive horses; they do not deny horses anything.
2. **The horse's input device.** A horse has no browser, so the engine
   supplies what a browser would: HorseLogic chooses its actions,
   `scheduleHorseAction` submits them inside the SAME turn timer a human
   gets, a synthetic heartbeat keeps its seat alive, and `autoRebuyHorse`
   funds its rebuy. Those exist to make a horse EQUAL to a human, not to
   give it a different deal. They are the only legitimate horse branch.

**THERE IS NO "EQUAL OUTCOME BY A DIFFERENT MECHANISM" EXEMPTION.** I proposed
one on 2026-08-27 — arguing a horse did not need the five-second rebuy pause
because `autoRebuyHorse` got it back another way — and Dan rejected it
outright:

> "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
> NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING
> FOR THE CLUB ARENA. YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO REBUY.
> NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU DIDN'T GIVE THEM
> THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"

**TIMING IS PART OF THE TREATMENT.** The tell is never one hand, it is the
RHYTHM: a table that stops for five seconds when one seat busts and rolls
straight on when another has just told every watching player which seats are
horses. And the pause is not ceremonial for a horse either — the stop-loss
(two rebuys) and an empty club treasury both mean it genuinely may not come
back, so the window it gets to decide has to be the same window.

The test is therefore **"is it identical"**, not "is it equivalent". Same
features, same functionality, same pauses, same timers, same rules.

Anything where horses would be reported as opt-in (a `p_include_horses`
parameter) MUST default to **true**.

### Why this rule exists

On 2026-08-27 I wrote `AND NOT COALESCE(p.is_horse, false)` into
`fn_settle_tournament_rake` on my own assumption that horses are "house
players" who should not earn. Nobody asked for it. Every tournament on this
platform is horse-heavy, so the effect was that tournament rake attribution
earned **nothing for anyone** — 39 settled events, zero VIP points, zero agent
commissions — and I then reported that zero as "correct behaviour". It was my
invention presented as a design decision, which is worse than a plain bug.

Fixed and backfilled in `20260827_horses_are_players_law.sql`, along with two
others found in the same sweep: horses were exempt from nit eviction, and a
lone horse was denied a dealing engine that a lone human would have received.

### Dan's rulings on the two collisions with physical constraints

Both were put to Dan on 2026-08-27 with the costs stated. His answers are
BINDING and are recorded here so nobody re-opens them as a "bug":

**1. Hand-history retention: STAYS AT 7 DAYS.** Horse-only hands are pruned
after `hand_history_retention_policy.horse_retention_days`; hands a human was
dealt into are kept forever. Equalising would cost ~0.5 GB/day (~15 GB/month)
on a table already at 3.6 GB — 221k hands/day, 99.95% of them horse-only. Dan
chose to leave it at 7. **This is the one sanctioned asymmetry in the entire
law, it is a STORAGE decision rather than a player-treatment one, and it is
Dan's to change — it is a config row, not code. Do not "fix" it.**

**2. The deploy drain gate: PROTECT THE HAND, NOT THE PLAYER.** The gate used
to read `humansSeatedTotal` and wait for HUMANS to leave, so a horse's hand
was voided by a restart without a second thought. It also waited for the wrong
event — a table EMPTYING can take forever and, with horses seated, never
happens, so it deferred for hours and then restarted under seated players
anyway. Fixed both ways: `/health` publishes `handsInFlightTotal` (every
player counted), the gate waits on that, and `GameServer.drainHands()` parks
every table at a hand boundary on SIGTERM — so hands are protected on EVERY
restart path, not just the deploy workflow that remembered to ask.

### Previously open, now closed

Both items above were open questions when this section was first written.
They are now decided; see Dan's rulings.

---

## 10.6 ANIMATION LAW + NO AUTO TABLE SWITCHING (Dan 2026-08-28, BINDING)

**1. ANIMATIONS MUST ALWAYS PLAY.** Dan, verbatim: "MAKE SURE THAT ANIMATIONS
CAN'T REGRESS, ONLY IMPROVE FROM HERE ON OUT. YOU NEED TO MAKE IT LAW THAT
THEY MUST ALWAYS PLAY." Every animation and its sound plays every time it is
owed, for its full duration, at the player's chosen Animation Speed. The
enforcement is `tests/animations-always-play.law.test.ts` (plus
`tests/unit/handCompletionLaw.test.ts` for the end-of-hand cadence): every pin
in it is a bug that actually shipped — a silent celebration cue, a skipped
deal, a flip cancelled mid-hold, a shake on the wrong table. If your change
turns a pin red, you are re-shipping one of those bugs. Fix your change; never
weaken a pin. If you deliberately replace a mechanism with a better one, move
the pin to the new mechanism IN THE SAME COMMIT and say so in the PR.
Corollaries: no new toggle may disable an animation outright (speed scaling
via `--animation-speed` is the only sanctioned control; `skip_animations` is
dead and stays dead), reduced-motion collapses motion but never meaning
(`data-motion="keep"` for duration-carrying animation), and a sound cue with a
literal volume of 0 is a bug by definition.

**2. NEVER AUTO-CHANGE TABLES.** Dan, verbatim: "YOU CAN NEVER EVER AUTO
CHANGE TABLES FOR A USER, THEY MUST CHANGE IT BY THEM SELF." The urgency
auto-switch and the post-action queue advance are DELETED from MultiTablePage;
their setting keys are tombstoned. Alerts (bell, flash, haptics, tab title)
are welcome; moving `activeIndex` without a user gesture is forbidden, no
matter what setting, however opt-in, is proposed to gate it. Enforced by
`tests/no-auto-table-switch.law.test.ts`.

---

## 10.7 EM DASH COPY AND M-BAR ARTWORK ARE SEPARATE BANS (BINDING)

There are two independent user instructions:

- Player-facing copy may not contain em dashes (U+2014). The copy transforms
  and CI text gate enforce this punctuation rule.
- No M bars or three-horizontal-line menu artwork. This is separately banned
  everywhere, including inside images. Navigation behavior and accessible
  names remain, while every visible drawer trigger uses the approved
  command-grid artwork.

Do not infer that clarification of the punctuation rule permits hamburger
bars. It does not. Do not add or restore three-line glyphs, SVG paths,
rectangle geometry, rasters, composite headers, or generated bundle content.
The canonical law is `tests/unit/noThreeBarArtwork.law.test.ts`; the six retired
stable URLs must remain absent and cache-tombstoned in `public/sw-bus.js`.

---

## 11. AGENT NETWORK + DEPLOY PLAYBOOK

### 11.0 FIRST: WHICH ENVIRONMENT ARE YOU IN? (added 2026-09-01, binding)

Everything below 11.0 was written for the CLOUD sandbox and is still true
there. It is WRONG for a Cowork session running on Dan's Mac, and following it
there costs an hour before you find out. Check first, in this order:

**If you have `mcp__counselors__host_terminal`, you are on the Mac. Use it for
everything.** Real bash on Dan's machine, where `git@github.com` over SSH works
and `api.github.com` is reachable. Then:

- **Claim a worktree** (AGENT-PLAYBOOK): `git worktree add -b fix/<slug>
~/Documents/.agent-trees/club-arena/<name> origin/main`. Takes about 40
  seconds - launch it with `nohup ... &` and return immediately, because the
  tool kills the process group when a call times out.
- **`node` is NOT on the default PATH.** Prefix every command with
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`.
- **The pre-push hook takes about three minutes** (guards, `tsc`, then the tests
  covering your diff). Launch the push with
  `nohup git push > /tmp/push.log 2>&1 < /dev/null & disown`, return
  immediately, and poll the log in later calls. Never `--no-verify`.
- **`gh` is not installed.** Open pull requests with `curl` against the REST
  API. The token is `GITHUB_TOKEN` in `~/Documents/club-arena/.env`.
- **Rebasing your branch onto main is refused by a ref-guard hook.** Use
  `git merge origin/main` instead. Section 12 still forbids rebasing `main`.

**The GitHub MCP (`mcp__github__*`) returns `Bad credentials` as of
2026-09-01.** Every call fails, including read-only ones. Do not debug it and
do not build a plan around it; use the host terminal. If you are reading this
long after that date, one call will tell you whether it is back.

**Do not hand-edit `scripts/ci/supabase-schema-manifest.json` or
`supabase-columns-manifest.json`.** They are nightly snapshots and were the
most-changed files on main - 25 and 14 commits in one day - which made every
migration-bearing branch conflict with every other one. Declare what you
created in your own file under `scripts/ci/schema-manifest.d/`. See the README
there.

---

### 11.1 The cloud sandbox (added 2026-07-23; corrected same day after live use)

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
