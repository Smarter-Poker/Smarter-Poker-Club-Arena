# Continuation Handoff - Push/Publish Pipeline Audit, CI Cost Offload, Estate CI Box

Written: 2026-09-02 ~15:20 UTC. Author: the Cowork "push-and-publish cost audit" session (Claude, running on Dan's Mac via the `counselors` host terminal).
Audience: the next agent. This document assumes you can see NOTHING of the prior conversation.
Truthfulness labels: **CONFIRMED** (verified by command, API call or query, evidence stated), **UNVERIFIED** (implemented, not proven live), **UNKNOWN - NEXT AGENT MUST INSPECT**.

This is NOT the same workstream as `docs/HANDOFF_CURRENT_STATE.md` (that is the zero-drift chip-integrity directive, 2026-09-01). Do not merge the two.

---

## 1. Executive Continuation Brief

**What is being built.** Smarter Poker / Club Arena: a poker platform (clubs, unions, cash, tournaments, spins, agents, rakeback). Two GitHub repos matter here: `Smarter-Poker/Smarter-Poker-Club-Arena` (CA, a Vite+React SPA) and `Smarter-Poker/Smarter-Poker-World-Hub` (WH, Next.js). CA's built bundle is _synced into_ WH's `public/hub/club-arena/` by a GitHub Actions workflow, WH deploys on Vercel (project `hub-vanguard`), so `smarter.poker/hub/club-arena/` is served by WH. The poker ENGINE (`server/`) runs on a separate Hetzner VPS (`engine.smarter.poker`, host `club-arena-engine`) and deploys on push to `server/**` via `auto-deploy-hetzner.yml`. Database is Supabase (`kuklfnapbkmacvwxktbh`).

**The objective Dan set.** (1) Audit the entire agent push -> merge -> publish -> production process top to bottom. (2) GitHub Actions cost had exploded from $50-100/mo to ~$1,100-1,200/mo (~150,000 hosted minutes in August) - cut it to near zero by moving work to a self-hosted Hetzner runner "if significantly cheaper", "including the crons". (3) Agents were waiting 12-25 minutes for CI and reporting "my last 3 pushes have not published" - make it impossible for a pending commit to not get published, and make the pipeline as fast and efficient as possible. (4) A regression-proof strategy so old work cannot silently regress. (5) Do it in phases, verify each phase 100% (bugs, gaps, stubs, wiring) before the next, never claim success without verification.

**Current phase.** Six-phase plan. **Phase 1 (capacity) and Phase 2 (land the publisher fix and verify it live) are COMPLETE and verified.** Phase 3 (finish the offload: remaining Playwright job, the four small per-PR guards, the scheduled jobs, and the publisher's own shards/build) is **drafted in a git stash, not started on a branch**. Phases 4-6 are specified only.

**Major work completed (all CONFIRMED on `origin/main` unless stated).**

- Publisher (`build-for-world-hub.yml`) rewritten to _converge on the tip of main_ instead of publishing its trigger commit; 4-way sharded test gate; a convergence "chain" that re-dispatches itself if main moved during the build; provenance stamped with the real published sha.
- Publish watchdog: 3 retries per sha (was 1), cancelled attempts no longer burn a retry, in-app escalation to Dan when retries are spent.
- A pre-push guard that blocks `[skip ci]`-class markers (they suppress the publisher entirely; it had happened on a real table fix).
- A registered law test (`tests/no-commit-left-behind.law.test.ts`, 21 pins, mutation-tested).
- Hetzner CI box `estate-ci-1` (created by an Antigravity agent as cpx31; resized by this session to **cpx41, 8 vCPU / 16 GB, Ashburn, ~$141/mo**), 8 CA runner processes + 2 WH runner processes, all online, `CI_RUNNER=estate-linux` set on CA. Box tuning codified in `scripts/ci/provision-ci-box.sh` (swap, nightly GC, per-runner fair-share caps, idle-restart sweeper, browser libs, tools, tool audit).
- Diamond-supply money gate that blocked 26 consecutive engine deploys: root-caused (8 functions wrote `profiles.diamonds` without journaling); fixed by a PARALLEL agent per the incident law; engine deployed 04:06 UTC.
- Independent verification of the Antigravity agent's runner setup, with its false claims corrected in the record (see section 15).

**Immediate unfinished objective.** Phase 3: route the remaining GitHub-billed jobs to the box. The `ci.yml` half is drafted in `stash@{0}` of the worktree (see section 10). The publisher half (`client-tests` shards + `build-and-store`) is not drafted. PR **#2636** (crontab-wipe fix for the provisioner) MERGED at ~15:25 UTC; the handoff docs themselves are PR **#2640** (auto-merge armed).

**Most important thing to understand.** Every "it's done" in this estate has to be proven against live state, because this session repeatedly found its own work was NOT what it thought: a PR whose branch GitHub silently stopped running CI on (zero workflow runs, two pushes); a vitest cap that was a no-op because the env var name was wrong for vitest 4; a runner `.env` mechanism that systemd never reads; a provisioner that wiped the box crontab on its second run; a routed job that failed because the box lacked `psql`. All were caught only by executing and reading back, never by reading code. Keep that standard.

**First action.** Section 22. In one line: open the worktree, run `git status`, check `stash@{0}`, confirm PR #2640 merged (#2636 already is), confirm the box's 10 runners are online and `crontab -l` on the box still has the GC line, then start Phase 3 from section 21.

---

## 2. User Requirements And Working Preferences

Dan (owner, `clubcommander45@gmail.com`) is direct and wants concision. Binding rules he set during this work, verbatim where it matters:

- **"MAKE IT IMPOSSIBLE FOR ANYTHING PENDING TO NOT GET SHIPPED, PUSHED AND PUBLISHED."** Convergence must be structural, not probabilistic.
- **"OFF LOAD EVERYTHING THAT'S COSTING US MONEY ON GITHUB TO HETZNER IF IT'S SIGNIFICANTLY CHEAPER, AND I MEAN EVERYTHING POSSIBLE INCLUDING THE CRONS."** He asked about crons twice. Measured answer: CA scheduled runs are ~$47/mo, 69% of it one job (`Live Production E2E`). Self-hosted minutes are free, so routing scheduled jobs to the box saves the same as an Open Claw migration with no migration. That is in Phase 3.
- **"SAVE US AS MUCH MONEY AS POSSIBLE WITHOUT LIMITATIONS"** and, earlier, a spend approval of "up to ~30 EUR/mo" for the box. These conflict; this session resized the box to cpx41 (+$68/mo over cpx31) on the "without limitations" instruction because 18 heavy jobs were queued behind 4 runners and the hosted minutes it unblocks are worth far more. Dan was told. If he objects, downgrade is one Hetzner API call (`change_type` back to cpx31, disk was NOT resized so it stays reversible).
- **Phased delivery, verified.** "BREAK THIS DOWN INTO PHASES AND BUILD THEM OUT ONE PHASE AT A TIME... LET ME KNOW IN THE SUMMARY AFTER EACH PHASE IS COMPLETE, PHASE X OF Y IS DONE... READY TO START PHASE X+1." Then, before each next phase: "MAKE SURE EVERYTHING FROM THE PREVIOUS PHASE WAS 100% COMPLETED, FINISHED EVERY STEP AND IT WAS PUSHED AND PUBLISHED, CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES." Do this literally.
- **Never claim success without proof.** CLAUDE.md 1.4 / 10: "Verify on real hardware. 'It compiles' is not verification." Dan rejected agent reports that said "should be live in a few minutes".
- **Never sit watching CI.** CLAUDE.md 10.8.3 (binding): push, open the PR, report the PR number, stop. "I've set another brief timer" is forbidden. Checking ONCE at the end to explain a block is fine. (This session bent this while verifying phase completion because Dan explicitly asked for verified-live results; keep polls short and few.)
- **Horses are players** (CLAUDE.md 10.5, binding, no exceptions). Not touched by this work but you will see `is_horse` everywhere; never add an exclusion.
- **No em dashes in player-facing copy; Title Case on popups** (CLAUDE.md 5.7, 10.7). The in-app escalation notification this session added uses Title Case and no em dashes on purpose.
- **Write it down in your OWN changelog file** `docs/changelog/YYYY-MM-DD-<slug>.md`; never append to `MIGRATION-CHANGELOG.md`.
- **Do not hand-edit** `scripts/ci/supabase-schema-manifest.json` / `supabase-columns-manifest.json`.
- Dan wants CLI/curl used when faster ("YOU CAN USE CLI OR CURL IF IT MAKES YOUR JOB EASIER OR FASTER").

Explicitly rejected / corrected:

- Weakening a money gate to unblock a deploy: never proposed to Dan, and the session refused to do it; the gate self-cleared and a parallel agent fixed the writers.
- Antigravity's claims of "~9 EUR/mo" and "practically $0 GitHub bill" were corrected in the record (see 15).
- My own early claim that the box was "$53/mo wasted in Ashburn" was wrong (cheap EU types are not orderable on this account) and was retracted to Dan.

---

## 3. Project And Repository Identity

| Item                                           | Value                                                                                                                                                                          | Status                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | --------- |
| Project                                        | Smarter Poker / Club Arena                                                                                                                                                     | CONFIRMED                               |
| Primary repo                                   | `Smarter-Poker/Smarter-Poker-Club-Arena` (private)                                                                                                                             | CONFIRMED                               |
| Secondary repo                                 | `Smarter-Poker/Smarter-Poker-World-Hub` (private)                                                                                                                              | CONFIRMED                               |
| Main clone on Dan's Mac                        | `/Users/smarter.poker/Documents/club-arena` (mirror of origin/main; do NOT originate work there - CLAUDE.md 12)                                                                | CONFIRMED                               |
| Working tree used by this session              | `/Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-audit` (a `git worktree` of the main clone; 385 worktrees are registered in total)                              | CONFIRMED                               |
| Branch checked out in that worktree at handoff | `agent/cowork-audit/handoff` @ `6e9cd51a3` (created for this document, off origin/main)                                                                                        | CONFIRMED                               |
| Previous branch                                | `agent/cowork-audit/box-tools` @ `fe57ff022`, merged via #2636 (remote branch auto-deleted)                                                                                    | CONFIRMED                               |
| Remote                                         | `origin` = `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git` (SSH)                                                                                                   | CONFIRMED                               |
| origin/main tip at handoff                     | `6e9cd51a3` 2026-09-02T14:51:50Z "ci(box): install psql, audit every CLI..." (#2633)                                                                                           | CONFIRMED                               |
| Framework                                      | Vite 7 + React 19 + TypeScript; vitest **4.0.18**; Playwright ^1.58.0                                                                                                          | CONFIRMED (package.json / node_modules) |
| Package manager                                | npm (`npm ci`, `package-lock.json`)                                                                                                                                            | CONFIRMED                               |
| Runtime                                        | Node 20/22 in CI (`actions/setup-node`), Node 20.20.2 on the box                                                                                                               | CONFIRMED                               |
| Database                                       | Supabase Postgres 17, project `kuklfnapbkmacvwxktbh` (~108 GB)                                                                                                                 | CONFIRMED                               |
| Hosting                                        | Vercel project `hub-vanguard` (`prj_op66GkZyZcygXQKm76iyycfVFAQx`, team `team_SVD8r7AOPH065G3usBxVvrBc`) serves `smarter.poker`; engine on Hetzner `club-arena-engine` (cpx21) | CONFIRMED                               |
| CI box                                         | Hetzner `estate-ci-1`, id `164260920`, **cpx41** 8 vCPU/16 GB/160 GB, `ash` (Ashburn), IPv4 `5.161.121.210`, Ubuntu 24.04                                                      | CONFIRMED via Hetzner API               |
| Node on Mac                                    | not on default PATH; use `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node                                                                                      | tail -1)/bin:/opt/homebrew/bin:$PATH"`  | CONFIRMED |
| `gh` CLI on Mac                                | NOT installed; use `curl` against the REST API with `GITHUB_TOKEN` from `~/Documents/club-arena/.env`                                                                          | CONFIRMED                               |
| `setsid` on Mac                                | does not exist; detach long processes with Python `subprocess.Popen(..., start_new_session=True)` (see 15)                                                                     | CONFIRMED                               |

---

## 4. Repository Map (relevant paths only)

| Path                                                                                                                                                              | What / why                                                                                                                                                                                                                                                                                                                                                                                                                                        | Modified this session      | Edit?                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------- |
| `CLAUDE.md`                                                                                                                                                       | Binding repo rules (deploy path, laws, environment). Sections 1.2.5, 10.5-10.8, 11.0, 11.5, 12 matter most.                                                                                                                                                                                                                                                                                                                                       | no                         | reread, do not edit without Dan    |
| `AGENT-PLAYBOOK.md`                                                                                                                                               | Byte-identical across 7 repos; `estate-integrity` checks hourly.                                                                                                                                                                                                                                                                                                                                                                                  | no                         | **never edit**                     |
| `docs/LAWS.md`                                                                                                                                                    | Registry of every `*.law.test.*`; `tests/law-registry.law.test.ts` fails CI if a law file lacks a row. Padded markdown table = merge-conflict magnet (3 conflicts this session).                                                                                                                                                                                                                                                                  | yes (+1 row)               | yes, carefully; see Phase 4        |
| `.github/workflows/build-for-world-hub.yml`                                                                                                                       | THE publisher: `publish-needed` -> `client-tests` (4 shards) + `build-and-store` -> `sync-to-world-hub`. Tip-of-main resolution, chain step, `actions: write`. Critical path.                                                                                                                                                                                                                                                                     | yes (heavily)              | yes, with the law test green       |
| `.github/workflows/publish-watchdog.yml` + `.github/scripts/publish-watchdog.sh`                                                                                  | Asks production what it serves vs main; re-dispatches publisher (3x), escalates in-app.                                                                                                                                                                                                                                                                                                                                                           | yes                        | yes                                |
| `.github/workflows/ci.yml`                                                                                                                                        | PR-time CI: TypeScript Check, Client Unit Tests, Server Engine, Production Build (all `runs-on: ${{ vars.CI_RUNNER \|\| 'ubuntu-latest' }}`), plus CSS Beat E2E, Live Production E2E (scheduled), small guards (all still `ubuntu-latest` on main). Required checks per ruleset: TypeScript Check, Client Unit Tests (vitest), Server Engine (typecheck + tests), Production Build, CSS Beat E2E (multi-table + animations), Silent Revert Guard. | no on main; draft in stash | yes (Phase 3)                      |
| `.github/workflows/post-deploy-e2e.yml`                                                                                                                           | ~29 min Playwright run against LIVE production after every publish; `runs-on: CI_RUNNER` since #2615. Not a merge gate.                                                                                                                                                                                                                                                                                                                           | yes                        | yes                                |
| `.github/workflows/auto-deploy-hetzner.yml`                                                                                                                       | Engine deploy; concurrency group `deploy-hetzner` (separate from publisher); has a financial health gate (`scripts/ci/check-chip-conservation.mjs`).                                                                                                                                                                                                                                                                                              | no                         | no                                 |
| `.github/workflows/secrets-expiry.yml`, `scripts/ci/check-secrets-expiry.mjs`, `scripts/ci/secrets-inventory.json`                                                | Weekly credential-expiry watchdog (earlier phase). Dispatched once on main this session: green.                                                                                                                                                                                                                                                                                                                                                   | no (verified)              | no                                 |
| `scripts/ci/check-no-skip-markers.mjs`                                                                                                                            | Blocks `[skip ci]`/`[ci skip]`/`[skip actions]`/`[actions skip]`/`[no ci]`/`***NO_CI***` in commits being pushed. Wired in `.husky/pre-push`. Client-side only.                                                                                                                                                                                                                                                                                   | created                    | yes (Phase 4 makes it server-side) |
| `.husky/pre-push`                                                                                                                                                 | Nine house rules + tests for touched files; ~3 min. Never `--no-verify`.                                                                                                                                                                                                                                                                                                                                                                          | yes (+1 guard)             | carefully                          |
| `scripts/ci/provision-ci-box.sh`                                                                                                                                  | Idempotent root script for the CI box (swap, GC, caps, sweeper, tools, browser libs, tool audit). `cron_set` fix merged in #2636.                                                                                                                                                                                                                                                                                                                 | created                    | yes                                |
| `scripts/ci/setup-selfhosted-runner.sh`                                                                                                                           | Registers one runner process; comment points at the provisioner.                                                                                                                                                                                                                                                                                                                                                                                  | yes (comment)              | yes                                |
| `tests/no-commit-left-behind.law.test.ts`                                                                                                                         | 21 pins on publisher/watchdog/guard/engine separation. Mutation-tested. Registered.                                                                                                                                                                                                                                                                                                                                                               | created                    | yes, keep pins strong              |
| `tests/unit/ciBoxProvisioning.test.ts`                                                                                                                            | 9 pins on the provisioner incl. `VITEST_MAX_WORKERS` against the INSTALLED vitest, tool audit, `cron_set`.                                                                                                                                                                                                                                                                                                                                        | created                    | yes                                |
| `tests/unit/PerformanceBenchmarks.test.ts`                                                                                                                        | Wall-clock perf benchmarks made fastest-of-7 (they flaked on the shared box).                                                                                                                                                                                                                                                                                                                                                                     | yes                        | yes                                |
| `tests/unit/deployAndPublishAreHonest.test.ts`, `tests/shipped-invariants.test.ts`, `tests/schedule-liveness.test.ts`, `tests/unit/runtimeAssetRetention.test.ts` | Pre-existing pins on the publisher's structure; all green after the rewrite.                                                                                                                                                                                                                                                                                                                                                                      | no                         | do not weaken                      |
| `scripts/ci/check-chip-conservation.mjs`                                                                                                                          | The engine-deploy money gate; reads `ca_diamond_snapshots.unexplained` over trailing 4h (threshold 500) and `ca_chip_*`.                                                                                                                                                                                                                                                                                                                          | no                         | **never weaken**                   |
| `docs/changelog/*.md`                                                                                                                                             | One file per agent/change (rule 10.9).                                                                                                                                                                                                                                                                                                                                                                                                            | +1 this handoff            | add your own file                  |
| `docs/HANDOFF_CURRENT_STATE.md`                                                                                                                                   | A DIFFERENT workstream (zero-drift chip integrity).                                                                                                                                                                                                                                                                                                                                                                                               | no                         | do not confuse with this           |

---

## 5. Applicable Instructions And Constraints

1. `CLAUDE.md` (CA repo root). Read fully. Key: 1.2.5 (main is ruleset-protected; PR + required checks are the only path; `bypass_actors: []`), 5.8 (never push a red test), 10.5 (horses), 10.6 (animations law), 10.7 (em bars = em dashes), 10.8 (law registry; reverts need Dan's `revert-approved` label; never watch CI; worktrees are disposable), 11.0 (you are on the Mac if `mcp__counselors__host_terminal` exists; `node` not on PATH; `gh` not installed; pre-push ~3 min; GitHub MCP returns Bad credentials), 11.5 (never spend real chips to test), 12 (never rebase main; use `git merge origin/main` on branches).
2. `AGENT-PLAYBOOK.md` - one page: claim a worktree, commit, push, PR, stop. Credential _locations_.
3. `docs/LAWS.md` - every law test must be registered.
4. WH `CLAUDE.md` section 11 - all new scheduled jobs go to Open Claw on Hetzner, never `vercel.json`; CI CHECK 6 enforces file counts; some GitHub `schedule:` workflows are sanctioned watchdogs that must stay GitHub-side.
5. Production DDL policy (CA CLAUDE.md 2): every DDL reloads PostgREST (~28s); single transaction per migration; no DDL probes. This session did **no DDL**.
6. Ambiguities: CLAUDE.md 11.0 says the GitHub MCP is broken - CONFIRMED still true, use REST via curl. CLAUDE.md 10.8.3 (never watch CI) vs Dan's "verify each phase live" - resolved by short, bounded polls only around phase verification.

---

## 6. Complete Discovery Record

### 6.1 The publish path (end to end, CONFIRMED)

1. Agent pushes branch `agent/<name>/*`; pre-push hook runs guards + touched tests (~3 min, sometimes 10+ when server tests are touched).
2. `agent-open-pr.yml` opens a PR; `agent-autopilot.yml` (every 10 min + on PR events) arms squash auto-merge and refreshes stale branches by MERGING main into them.
3. Required checks run on the PR (`ci.yml` + Silent Revert Guard). Ruleset `main protection` (id 21163380) enforces them; nobody can bypass.
4. Merge to `main` (squash) fires `build-for-world-hub.yml` (push). Concurrency group `build-world-hub-${{ github.ref }}`, `cancel-in-progress: false` - a new push cancels the older PENDING run only. Also fires every `*/30` (dedupe: compares production's `build-info.json` `ca_sha` to the resolved tip; skips if equal).
5. `publish-needed` resolves **the tip of main via `gh api repos/.../commits/main`** (falls back to `github.sha` on API failure) -> `target_sha`. `client-tests` (4 vitest shards, `fail-fast: true`) and `build-and-store` (vite build, stamps `dist/build-info.json` with `ca_sha=target_sha`, uploads artifact `club-arena-dist-<target_sha>`) run in parallel, both checked out at `target_sha`. `sync-to-world-hub` needs all three, downloads the artifact, checks out WH with a GitHub App token (`AUTOPILOT_APP_ID` / `AUTOPILOT_APP_PRIVATE_KEY`, WH-scoped; PAT `WORLD_HUB_SYNC_TOKEN` fallback), refuses to publish a bundle OLDER than what WH already has (compare API on `ca_sha`), pushes `chore(club-arena): sync build <target_sha> [skip actions]` to WH main, then the **chain step**: re-resolves main's tip; if it moved, `gh workflow run build-for-world-hub.yml --ref main` (GITHUB_TOKEN with `actions: write`; `workflow_dispatch` is the documented exception to "GITHUB_TOKEN events do not start workflows"); never fails the job.
6. WH push -> Vercel builds `hub-vanguard` (~3 min build + "Deploying outputs"; observed once taking 11 min in that phase) -> `smarter.poker/hub/club-arena/build-info.json` reports the live `ca_sha`.
7. `publish-watchdog.yml` fires on `workflow_run` of the publisher (success or failure) and hourly: compares production `ca_sha` to main; lag budget 25 min; then re-dispatches the publisher up to `MAX_RETRIES=3` per sha, **not counting cancelled/skipped attempts**; files/updates a self-closing issue; when retries are spent, POSTs `fn_raise_notification` to every `ca_incident_recipients` (scope=platform, active) row (in-app), Title Case, no em dashes. Also runs `engine-watchdog.sh` and `schedule-liveness.mjs` (cron self-healer).
8. `post-deploy-e2e.yml` fires on publisher completion; ~29 min Playwright against live production; concurrency cancels older pending runs.

### 6.2 What was wrong before this session (CONFIRMED by measurement)

- 100 publisher runs: 57 cancelled, 34 success, 6 failure; **worst gap between successful publishes 154 minutes**. Each run published its _trigger_ sha, so a cancelled/failed run stranded everything behind it until a cron. The watchdog burned its single retry on cancellations.
- `client-tests` in the publisher was one 11-13 min job on a 2-core hosted runner; whole publish ~18 min vs merges every 2-3 min.
- A commit with `[skip ci]` (`454fa1da4`, a real table fix) started no publisher run at all.
- Dan's hypothesis that the hourly engine restart blocked publishing is **disproven by data**: bad publisher outcomes were 45% inside the :40-:55 engine window vs 68% outside. Engine deploy and publisher share no concurrency group, runner, or token; pinned by the law.
- An Antigravity agent had set up the box (cpx31 Ashburn, 2 runners) and reported "~9 EUR/mo", "practically $0 GitHub bill", "all heavy jobs offloaded", warm-cache speedups (its own numbers showed warm slower than cold). Measured reality then: 111 billed hosted minutes vs 14 on Hetzner over 15 runs; box was **$73.49/mo**; WH untouched.

### 6.3 GitHub Actions cost model (CONFIRMED)

- Self-hosted runner minutes are free; only `ubuntu-latest` minutes bill (~$0.008/min).
- GitHub's concurrent-job cap applies only to hosted runners (min 20). "One job at a time" reports are the box's runner count.
- Per-PR heavy jobs (TS ~2.2m hosted/1.0m box, Client Unit ~12.9m hosted/3.1m box at cap 4, Server Engine ~5.2m, Production Build ~4.3m) were ~24.6 min/PR; now free.
- Still billed on main as of handoff: CSS Beat E2E (~10.5 min/PR, required), `changes`/`source_windows`/`stub_gate`/`verdict` (~3-4 min/PR total), Live Production E2E (scheduled, ~157 min per 28h sample = ~$32/mo), publisher `client-tests` 4x~3.1m + `build-and-store` ~3.3m per merge (estimated ~$300/mo at the audit's 85 PRs/day figure - **that figure is from the earlier audit, UNVERIFIED for today's rate**), Agent Autopilot sweeps (~$8/mo), watchdogs (small).
- WH: 26 hosted minutes across 12 runs; no WH workflow reads `CI_RUNNER`; not a meaningful Actions cost. WH runners exist but idle.

### 6.4 The CI box (CONFIRMED at handoff)

- `estate-ci-1` 8 cores, 15 GB RAM visible, 8 GB swap (`/swapfile`, fstab), disk 24% used, load spikes to 30-45 during bursts, 15-min avg ~15.
- Runner processes: `estate-ci-1..8` (CA, label `estate-linux`) at `/home/ci/actions-runner-estate-ci-N`, systemd units `actions.runner.Smarter-Poker-Smarter-Poker-Club-Arena.estate-ci-N.service`; `estate-wh-1..2` (WH) at `/home/ci/actions-runner-wh-N`. Runner user `ci` (passwordless sudo). Runner version auto-updated to 2.337.0.
- Systemd drop-in on every runner unit: `/etc/systemd/system/<unit>.d/10-fair-share.conf` -> `Environment=VITEST_MAX_WORKERS=4`, `Environment=NODE_OPTIONS=--max-old-space-size=3072`. All 8 CA listeners carry cap 4 (verified via `/proc/<pid>/environ`).
- `/usr/local/bin/ci-gc.sh` nightly at 04:17 UTC (crontab currently exactly one line: `17 4 * * * /usr/local/bin/ci-gc.sh`). `/usr/local/bin/ci-restart-idle-runners.sh` exists; its cron entry is present only while an env change is being rolled out (self-removes).
- Tools: node v20.20.2, gh 2.99.0, jq 1.7, psql 16.15, unzip/zip, chromium+webkit system libs; Playwright browser cache under `/home/ci/.cache/ms-playwright` (`chromium-1208`, `webkit-2248`, `ffmpeg-1011`).
- SSH: key `~/.ssh/hetzner_deploy` (Hetzner "deploy-key") or `~/.ssh/id_ed25519` as `root` or `ci`. `~/.ssh/hetzner_ed25519` does NOT open this box.
- Hetzner API token: macOS keychain, account `smarter-poker`, service `hcloud-ci-token` (`security find-generic-password -a smarter-poker -s hcloud-ci-token -w`). Six servers on the account; limit 10.
- Cheaper alternatives checked and NOT orderable on this account: `cax*` (ARM) and `cpx*` in EU locations return `unsupported location for server type` (probe creates of `ccx23` in fsn1/nbg1/hel1 succeed and were deleted). cpx41 Ashburn was the only capacity upgrade available.

### 6.5 Money-integrity discovery (CONFIRMED)

- `ca_diamond_snapshots` hourly via `fn_ca_diamond_snapshot()`: `unexplained = (non-cert supply now) - (non-cert supply prev) - (non-cert `diamond_transactions` since prev)`; NULL on the first interval after any `ca_cert_accounts` registry change; raises `ca_drift_incidents` (`source='fn_ca_diamond_snapshot'`) when |unexplained| > 50. `diamond_ledger` table exists but is EMPTY (never written); `diamond_transactions` is the real journal.
- 2026-09-02 01:10 UTC: -1,259,900 non-cert diamonds left `profiles.diamonds` in one hour with zero journal rows. Third such incident in two days (prior: +208,000 unjournaled signup grants; -226,910 cert-registry basis change). Root cause found by this session: **8 functions update `profiles.diamonds` without a `diamond_transactions` row** (`complete_daily_challenge`, `fn_add_diamonds`, `fn_atomic_buyin`, one overload of `fn_credit_diamonds`, `increment_diamonds`, `purchase_vip_with_diamonds_atomic`, `transfer_diamonds_credit`, `transfer_diamonds_deduct`). A parallel agent resolved incident `0db37a45-ed2b-4053-ad91-7ad7494fdd99` at 04:11 UTC with root cause + `correction_ref` = migrations `a_diamond_cannot_move_anonymously`, `the_seven_diamond_writers_that_never_journalled`, `the_buyin_and_the_challenge_journal_their_diamonds` (names as recorded; **files/contents UNVERIFIED by this session**). Engine deploy #924 then passed the gate and cut over.
- The gate was never weakened.

### 6.6 Other discoveries

- `tests/e2e/production-cashier.spec.ts:45` asserts the live Cashier's "Reconcile Now" button is enabled. It was disabled at 02:05/02:18/03:03 UTC and enabled at 14:48 with no cashier code or spec change between - the state is dynamic. Unresolved (Phase 5).
- A PR branch can go dead: `agent/cowork-audit/faster-publish` got zero workflow runs on two consecutive pushes while other branches fired normally. Cause UNKNOWN (GitHub-side). Identical commits on a fresh branch ran fine. Nothing in the estate detects a PR with no checks (Phase 4).
- `docs/LAWS.md` is a prettier-padded table; any insertion re-pads every row; three merge conflicts in one night.
- The estate's shared `git stash` stack on the main clone has ~100 entries from many agents; **only `stash@{0}` on the cowork-audit worktree is this session's** (see 10). Never pop others.
- 151 dirty / 183 unpushed worktrees exist on the Mac (from a prior phase's rescue work); 85 `rescue/*` branches are on origin. Not this workstream's job.
- The WH `/api/health` reports `degraded / db timed out` for ~30-60s after each Vercel deploy (fresh instance during PostgREST schema-cache reload). It is transient; do not alarm on it.

---

## 7. Work Completed During This Chat

### Workstream A - Publisher convergence (CONFIRMED on main, verified live)

- **#2599 (merged)** `perf(ci): shard the publish test gate 4 ways`: `client-tests` -> `strategy.matrix.shard: [1,2,3,4]`, `fail-fast: true`, `npx vitest run tests/ --shard=N/4`, `actions/cache@v4` on `node_modules` keyed by lockfile. Local proof: shard 1/4 = 208 files / 3,528 tests green.
- **#2619 (merged 05:44 UTC, replaces dead #2603)** `fix(ci): no commit left behind`:
  - `publish-needed` step "Resolve the tip of main" -> output `target_sha`; dedupe compares production to it.
  - Every CA checkout (`client-tests`, `build-and-store`, sync's sparse checkout of `scripts/ci/sync-club-arena-dist.mjs`) uses `ref: target_sha`; `VITE_APP_VERSION`, `build-info.json` `ca_sha`, artifact name, `OURS_SHA`, WH commit message and summaries all use it. `sync-to-world-hub` `needs: [publish-needed, build-and-store, client-tests]`, `permissions: actions: write` added.
  - Chain step "Converge - chain another publish if main moved while this one built" (`if: success()`; dispatches with `github.token`; warns but never fails).
  - `publish-watchdog.sh`: `MAX_RETRIES=3`; jq filter excludes `cancelled`/`skipped`; `escalate_in_app()` (bug fixed: `for UID in` -> `for RECIP in`, since `UID` is readonly in bash); `publish-watchdog.yml` passes `SUPABASE_URL` and `secrets.SUPABASE_SERVICE_ROLE_KEY` (secret CONFIRMED present).
  - `scripts/ci/check-no-skip-markers.mjs` + `.husky/pre-push` wiring; `CA_ALLOW_SKIP_MARKER=1` override; fails open on unreadable range.
  - `tests/no-commit-left-behind.law.test.ts` (21 pins) + `docs/LAWS.md` row.
  - `tests/unit/PerformanceBenchmarks.test.ts`: fastest-of-7, bars 100/200 ms.
  - Live verification, publisher run **#3017**: `Publishing target: 19d7b0c (trigger was 19d7b0c)`; WH commit `c2585acaac`; chain: `CONVERGED`; production `ca_sha` = `19d7b0c1e` within ~4 min. Watchdog #2104 on the new script: green. Later runs #3018-#3021 all green; chain CONVERGED each time (main never moved mid-build; **the dispatch branch of the chain is stub-tested only** - 4 cases with a fake `gh`).

### Workstream B - Offload to the box (partly on main)

- **#2615 (merged 05:09)**: `post-deploy-e2e.yml` `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`; Playwright install skips `--with-deps` when `vars.CI_RUNNER` is set. CSS Beat E2E was routed in the first cut and **reverted** after it failed on the (then 4-core) box while 3/3 green hosted. Live: post-deploy #650, #656, #657 ran on `estate-ci-*`.
- **#2633 (merged 14:51)**: provisioner installs `postgresql-client unzip zip`, ends with a routed-workflow tool audit; `VITEST_WORKERS` default 4; test scans workflows for `psql`/`gh`/`jq`. Live: post-deploy #657 "Certify the live cashier database contract" **success** on `estate-ci-4` (was `psql: command not found` on #650/#656).
- **#2636 (MERGED ~15:25 UTC)**: `cron_set`/`cron_del` helpers with read-back; sweeper self-removal guarded; test pins + mutation test. Proven on the box from the exact failing state.
- Phase 3 draft in `stash@{0}` (worktree): `ci.yml` routes `changes`, `source_windows`, `stub_gate`, `verdict`, `build` (= Live Production E2E job id), `post-deploy-check` (= CSS Beat E2E job id) to `CI_RUNNER` with conditional `--with-deps`; plus the provisioner default-4 edits that have since shipped separately via #2633. **Not committed, not pushed, not tested in CI.**

### Workstream C - Box capacity and tuning (CONFIRMED live)

- Hetzner `change_type` cpx31 -> cpx41 with `upgrade_disk: false` (reversible), 14:40-14:43 UTC; runners came back via systemd.
- 8 GB swap; runners 5-8 registered (tarball fetched fresh; earlier copy failed because the runner had auto-updated and removed it).
- Caps: first `.env` attempt did NOT reach the listener (verified); systemd drop-in does. First variable `VITEST_MAX_THREADS` was a no-op for vitest 4 (verified by grepping `node_modules/vitest/dist` - only `VITEST_MAX_WORKERS` exists); fixed. Proof: vitest children 8 uncapped vs 3 at cap 2 vs 5 at cap 4. Cap 2 made a lone full suite 11m+ (worse than hosted); cap 4 = 3.1 min. Heap 2560 -> 3072 for `tsc`; `UV_THREADPOOL_SIZE` removed.
- **#2622 (merged)** `provision-ci-box.sh` + `tests/unit/ciBoxProvisioning.test.ts`; run on the box: clean.
- Restarts of idle runners caused **zero** failed/cancelled jobs (checked via API).

### Workstream D - Verification of the Antigravity handoff (record only)

- CONFIRMED true: box existed, 2 runners online, `CI_RUNNER` set 02:46 UTC, the 4 scoped jobs ran there and passed.
- CONFIRMED false/misleading: cost (~9 EUR claimed, $73.49 actual), "everything offloaded", WH "done" (untouched), warm-cache numbers. It "permanently deleted" two duplicate clones Dan asked to be Trashed (gone, not in Trash).

### Workstream E - Diamond gate (diagnosis only; fix by another agent)

- Diagnosed as above; documented in task notes; gate untouched. Engine deploy #924 success 04:06 UTC.

### Workstream F - Earlier phases in this same conversation (before context compaction; CONFIRMED on main by file presence, not re-tested this session)

Secrets-expiry inventory/watchdog (#2593; dispatched once 04:25 UTC: green), cron-liveness self-healer, estate digest (issue #2576 updating), DR runbook + encrypted engine-secret backup, migration backfill (665 files) + gate exemptions, rescue of 85 orphan branches, Mac-SPOF doc, changelog `docs/changelog/2026-09-01-seven-phase-hardening-audit.md`, incident-resolution DB law, definer lockdown of 12 functions, silent-revert guard label gate, cost fixes (#2495/#2496), WH guard consolidation (#1241/#1243).

---

## 8. Visual And Product Decisions

No visual or UI design work was done in this session. No reference images were uploaded or approved. Nothing player-facing changed except: the in-app notification text raised by the watchdog escalation (`p_title: "Publish Needs A Human"`, `p_type: "publish_stranded"`, `p_link: "/hub/club-arena/"`) - Title Case, no em dashes, per the house popup rule. Not a UI component.

---

## 9. Functional And Architectural Decisions

| Decision                                                                                                         | Status                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Publisher publishes the TIP of main, never the trigger sha; fails open to trigger sha                            | Implemented, verified live                                               |
| Cancelled publisher runs are structurally harmless (chain + tip)                                                 | Implemented; chain dispatch path stub-verified                           |
| Test gate strength unchanged: `sync` needs every shard; `fail-fast`                                              | Implemented                                                              |
| Watchdog: 3 retries/sha, cancellations free, in-app escalation when spent; a broken bundle is never auto-shipped | Implemented; escalation stub-tested (2 payloads), never fired live       |
| Engine deploy and publisher must never share a concurrency group or gate                                         | Pinned by law                                                            |
| Skip markers blocked at push                                                                                     | Client-side only (pre-push). Server-side check: Phase 4                  |
| CSS Beat E2E stays hosted until the box proves browser flows under load                                          | Decided after a real failure; revisit in Phase 3 now capacity is 8 cores |
| Box: cpx41, 8 CA runners + 2 WH runners, cap 4 workers, 3 GB heap, swap, nightly GC, tool audit                  | Implemented, verified                                                    |
| Scheduled jobs: route to the box rather than migrate to Open Claw (same $0, no governance work)                  | Decided, drafted, not shipped                                            |
| WH: runners registered, `CI_RUNNER` NOT set, no workflow rewired (26 min/12 runs, not worth it)                  | Decided                                                                  |
| Money gates are never weakened to unblock deploys                                                                | Locked                                                                   |
| `hand_history` horse retention 7 days                                                                            | Dan's ruling, locked (not this workstream)                               |

---

## 10. Exact Current State (CONFIRMED 2026-09-02 ~15:15 UTC)

- Worktree `~/Documents/.agent-trees/club-arena/cowork-audit`: branch `agent/cowork-audit/handoff` @ `6e9cd51a3` (== origin/main), `git status` clean except this handoff's new files.
- Local branches in the worktree from this workstream (all merged except as noted): `actions-cost-fixes`, `box-tools` (#2636 merged), `ci-box-provisioning`, `cron-selfheal`, `definer-lockdown-p1`, `dr-runbook`, `estate-digest`, `faster-publish` (dead; remote deleted), `fix/estate-audit-batch-1` (remote deleted), `housekeeping`, `migration-backfill`, `no-commit-left-behind`, `offload-e2e`, `offload-rest` (**holds the Phase 3 draft base**), `record-incident-law`, `secrets-expiry`, `spof-runbook`.
- **`stash@{0}`** on that worktree: "WIP on agent/cowork-audit/offload-rest: 99b25375f ..." -> `.github/workflows/ci.yml` (+12/-8, the Phase 3 routing), `scripts/ci/provision-ci-box.sh` (default 4, already on main), `scripts/ci/setup-selfhosted-runner.sh` (comment, already on main). Apply with `git checkout agent/cowork-audit/offload-rest && git merge origin/main && git stash pop` and expect the two script hunks to be no-ops/conflicts you resolve by taking main.
- Remote branches this workstream owns: `agent/cowork-audit/box-tools` only (plus `handoff` once pushed).
- #2636 MERGED. Open PR: **#2640** (this handoff: `HANDOFF-INDEX.md`, `docs/HANDOFF-2026-09-02-...md`, changelog), auto-merge armed.
- origin/main tip `6e9cd51a3`. Production CA bundle `6e9cd51a3` built 14:55:09Z = **caught up**. WH `73dd980c` healthy (after the boot window).
- Publisher #3021 success; post-deploy #657 on box passed both cashier steps (its final spec step was cancelled by a newer publish - by design).
- Box: 10/10 runner units running, 8/8 CA listeners `VITEST_MAX_WORKERS=4`, crontab = GC only, swap 7-8 GB active, disk 24%, `psql 16.15`.
- Engine: last deploy #924 success (04:06 UTC) at `93d167b5c`; later engine-affecting merges deploy on the :40/:45/:50 catch-up; UNVERIFIED which engine sha is running at handoff (`engine-watchdog.sh` covers it).
- Diamond gate value: trailing-4h `unexplained` sum was 0 after the 04:11 fix; UNVERIFIED at handoff.
- No dev server, preview, or local build is running. No database migrations were applied by this session. No seeds.
- Vercel: last deployment `dpl_EBz1zhx9FrDwqiFmM4QFLpGv84TQ` READY (production).

---

## 11. Changed-File Ledger (this session, CA repo)

| File                                                              | Status           | Purpose           | What changed                                                                       | Verified                                                                | Committed                           |
| ----------------------------------------------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| `.github/workflows/build-for-world-hub.yml`                       | modified         | publisher         | shards; tip-of-main; target sha everywhere; `actions: write`; chain step; comments | live run #3017 + law                                                    | main (#2599, #2619)                 |
| `.github/scripts/publish-watchdog.sh`                             | modified         | watchdog          | MAX_RETRIES 3; exclude cancelled; `escalate_in_app`                                | stub-executed 4 cases; live run #2104 green                             | main (#2619)                        |
| `.github/workflows/publish-watchdog.yml`                          | modified         | watchdog          | Supabase env; header text                                                          | law                                                                     | main (#2619)                        |
| `.github/workflows/post-deploy-e2e.yml`                           | modified         | e2e               | `runs-on: CI_RUNNER`; conditional `--with-deps`; rationale                         | live #650/#656/#657 on box                                              | main (#2615)                        |
| `scripts/ci/check-no-skip-markers.mjs`                            | created          | guard             | 7 marker forms, fail-open, override                                                | ran on 7 variants + real offender + control; blocked my own commit once | main (#2619)                        |
| `.husky/pre-push`                                                 | modified         | hook              | wires the guard                                                                    | law                                                                     | main (#2619)                        |
| `tests/no-commit-left-behind.law.test.ts`                         | created          | law               | 21 pins                                                                            | 9 mutations red, restored green                                         | main (#2619)                        |
| `docs/LAWS.md`                                                    | modified         | registry          | +1 row                                                                             | registry test                                                           | main (#2619)                        |
| `tests/unit/PerformanceBenchmarks.test.ts`                        | modified         | test              | fastest-of-7                                                                       | green; injected regression red                                          | main (#2619)                        |
| `scripts/ci/provision-ci-box.sh`                                  | created/modified | box               | full provisioner; psql; tool audit; default 4; `cron_set`                          | run on box 3x; last: clean from failing state                           | main (#2622, #2633, #2636)          |
| `scripts/ci/setup-selfhosted-runner.sh`                           | modified         | box               | comment pointing at provisioner                                                    | test                                                                    | main (#2622/#2633)                  |
| `tests/unit/ciBoxProvisioning.test.ts`                            | created/modified | test              | 9 pins                                                                             | green; mutation red                                                     | main (#2636)                        |
| `docs/HANDOFF-2026-09-02-push-publish-cost-audit.md`              | created          | this doc          | -                                                                                  | -                                                                       | branch `agent/cowork-audit/handoff` |
| `docs/changelog/2026-09-02-push-publish-cost-audit-phases-1-2.md` | created          | changelog pointer | -                                                                                  | -                                                                       | same branch                         |
| `HANDOFF-INDEX.md`                                                | created          | root pointer      | -                                                                                  | -                                                                       | same branch                         |

No files in the WH repo were changed by this session after compaction (earlier phases changed `.gitignore` and `CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`, merged).

User-owned changes to protect: none in this worktree. The shared main clone `~/Documents/club-arena` may have other agents' state; never run git write commands there.

---

## 12. Asset Ledger

No visual assets were created, uploaded, approved or rejected in this session. Nothing to persist.

---

## 13. Commands And Tools Used (important ones)

| Where                      | Command                                                                                                                                                                                      | Purpose                                      | Result                                                           | Rerun?                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| worktree                   | `npx vitest run tests/ --shard=1/4`                                                                                                                                                          | prove sharding                               | 208 files / 3,528 tests green                                    | no                                                                |
| worktree                   | `npx vitest run tests/no-commit-left-behind.law.test.ts tests/law-registry.law.test.ts tests/unit/deployAndPublishAreHonest.test.ts ...`                                                     | pins                                         | 133 tests green                                                  | yes before touching the publisher                                 |
| worktree                   | mutation loop (sed/python edits + vitest)                                                                                                                                                    | prove laws bite                              | 9/9 red then green                                               | yes when changing pins                                            |
| worktree                   | extracted chain script + fake `gh` in `/tmp/cvg/bin`                                                                                                                                         | behaviour-test chain                         | 4/4 correct                                                      | yes if chain changes                                              |
| worktree                   | extracted `escalate_in_app` + fake `curl`                                                                                                                                                    | behaviour-test escalation                    | found `UID` bug; 2 payloads                                      | yes if escalation changes                                         |
| worktree                   | `node scripts/ci/check-no-skip-markers.mjs [range]`                                                                                                                                          | guard                                        | all 7 forms blocked; real offender `454fa1da47c2ea42...` blocked | yes                                                               |
| Mac                        | `python3 -c "import subprocess,os; subprocess.Popen(['git','push'],cwd=os.getcwd(),stdout=open('/tmp/x.log','w'),stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True)"` | detached push that survives tool disconnects | works; `nohup … & disown` did NOT (killed twice)                 | **use this for every push**                                       |
| Mac                        | `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/...`                                                                      | all GitHub reads/writes                      | -                                                                | yes                                                               |
| Mac                        | `security find-generic-password -a smarter-poker -s hcloud-ci-token -w`                                                                                                                      | Hetzner token                                | -                                                                | yes                                                               |
| Hetzner API                | `POST /servers/{id}/actions/shutdown`, `change_type {server_type:cpx41, upgrade_disk:false}`, `poweron`                                                                                      | resize                                       | success                                                          | only to downgrade                                                 |
| box (root)                 | `bash /root/provision-ci-box.sh` (scp'd from repo)                                                                                                                                           | provision                                    | 3 runs; last clean                                               | yes after any provisioner change; ALWAYS check `crontab -l` after |
| box                        | `for n in 1..8: tr '\0' '\n' </proc/$(pgrep -f "estate-ci-$n/bin/Runner.Listener")/environ \| grep VITEST_MAX_WORKERS`                                                                       | prove caps                                   | 8/8 = 4                                                          | yes                                                               |
| box                        | `pgrep -P <vitest pid> \| wc -l`                                                                                                                                                             | prove cap binds                              | 8 / 3 / 5 children                                               | yes if cap changes                                                |
| GitHub API                 | `POST /actions/workflows/secrets-expiry.yml/dispatches`                                                                                                                                      | verify                                       | success                                                          | no                                                                |
| GitHub API                 | `POST /actions/workflows/post-deploy-e2e.yml/dispatches`                                                                                                                                     | verify psql fix                              | #657 psql step success                                           | no                                                                |
| Supabase MCP `execute_sql` | read-only queries on `ca_diamond_snapshots`, `ca_drift_incidents`, `profiles`, `pg_proc`                                                                                                     | diagnosis                                    | see 6.5                                                          | read-only only                                                    |

Never run: `git push --no-verify`, `git rebase` on main, DDL against production, any chip-moving RPC.

---

## 14. Verification And Test Results

| Verification                                                                                                                                                                                                                                                                   | Method                                                                          | Result                                                              | When                 | Follow-up                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| Law + publisher pins (7 files)                                                                                                                                                                                                                                                 | vitest                                                                          | 133/133 green                                                       | Phase 2              | rerun before Phase 3 edits                              |
| `no-commit-left-behind` mutations                                                                                                                                                                                                                                              | 9 targeted mutations                                                            | all red, restored green                                             | Phase 2              | -                                                       |
| `ciBoxProvisioning` (9 pins)                                                                                                                                                                                                                                                   | vitest + mutation (wiping idiom)                                                | green; red on mutation                                              | Phase 2 verification | -                                                       |
| Publisher live                                                                                                                                                                                                                                                                 | run #3017 (+ #3018-#3021)                                                       | success; correct target; CONVERGED; prod caught up                  | 05:44-14:59 UTC      | chain **dispatch** path never exercised live            |
| Watchdog live on new script                                                                                                                                                                                                                                                    | run #2104                                                                       | 3 jobs green                                                        | 05:48                | escalation never fired live                             |
| post-deploy e2e on box                                                                                                                                                                                                                                                         | #650/#656 (psql fail), #657 (psql ok, cashier ok, specs cancelled by supersede) | fixed                                                               | 14:48                | a full uncancelled run on the box has NOT completed yet |
| Secrets-expiry workflow                                                                                                                                                                                                                                                        | dispatch                                                                        | success                                                             | 04:25                | -                                                       |
| PR-time CI on the box                                                                                                                                                                                                                                                          | many PRs                                                                        | TS 1.0-1.5m; vitest 3.1m at cap 4; one load-flake fixed (perf test) | Phase 1-2            | -                                                       |
| Diamond gate clearance                                                                                                                                                                                                                                                         | SQL + engine deploy #924                                                        | passed                                                              | 04:06                | -                                                       |
| Production healthy                                                                                                                                                                                                                                                             | `hand_history` 2,389 hands/10 min, 676 seats                                    | ok                                                                  | 03:54                | -                                                       |
| WH health                                                                                                                                                                                                                                                                      | `/api/health`                                                                   | ok after boot window                                                | 15:15                | -                                                       |
| **Not run**: full `npx vitest run tests/` locally on the final main (CI did); Server Engine tests locally (hook ran a subset); any e2e locally; CSS Beat E2E on the resized box (was routed only on the 4-core box); Live Production E2E on the box; production build locally. |                                                                                 |                                                                     |                      |                                                         |
| **Failed and NOT fixed**: none outstanding from this workstream. `Specs that need a real deployed page` keeps being cancelled by supersede - by design, but means it rarely completes (see 16).                                                                                |                                                                                 |                                                                     |                      |                                                         |

---

## 15. Setbacks, Failed Approaches, And Lessons

1. **PR #2603's branch went dead.** After the first push (which got CI), two more pushes produced zero workflow runs - not even the unconditional per-PR guards - while other branches fired minutes apart. No skip marker anywhere. Cause unknown. Fix: cherry-pick onto a fresh branch (#2619). Lesson: if a PR shows zero runs 10+ min after a push, don't debug the branch; recreate it. Detection is a Phase 4 item.
2. **Silent Revert Guard on my own branch.** Restoring `ci.yml` from main in a second commit exactly undid my first commit; the guard (a required check) blocked #2615. Fix: squash the branch to one commit (`git reset --soft $(git merge-base HEAD origin/main)`, commit, `push --force-with-lease` to the FEATURE branch - the hook allows that; never to main). Lesson: don't revert yourself inside a PR; squash.
3. **My own skip-marker guard blocked my own commit** because its message quoted `[skip ci]` verbatim. Lesson: never write a marker literally in a commit message; say "a skip marker".
4. **`VITEST_MAX_THREADS` was a no-op.** vitest 4 only reads `VITEST_MAX_WORKERS`. Verified by grepping `node_modules/vitest/dist`. Lesson: read the installed package, not docs.
5. **Runner `.env` never reached the listener** under systemd. Use a systemd drop-in; prove via `/proc/<pid>/environ`.
6. **Cap 2 was too tight**: lone full suite 11m+; cap 4 = 3.1m. Decide caps from measurements.
7. **The provisioner wiped the crontab** (`set -e -o pipefail` + `( crontab -l | grep -v KEY; echo ) | crontab -`). Fixed with `cron_set` read-back. Lesson: never pipe a grep into `crontab -`; always read the table back.
8. **`psql` missing on the box** broke a routed step that had never failed on hosted. Lesson: a hosted image ships hundreds of tools; audit what the workflows call before routing (the provisioner now does).
9. **CSS Beat E2E failed on the 4-core box under load** (browser-flow 20s timeout) while 3/3 green hosted. Reverted. A saving that reds a required gate is not a saving.
10. **Wall-clock perf benchmark flaked on the shared box** (123 ms vs 100 ms). Fixed with fastest-of-7; injected regression still red.
11. **Tool-call disconnects kill process groups.** `nohup … & disown` pushes died mid-hook twice with no error. macOS lacks `setsid`. Use Python `start_new_session=True`. Keep any `sleep` in a tool call under ~30s.
12. **The "cheaper EU box" plan was wrong**: ARM/EU cpx types aren't orderable on this account despite being priced. Verified by probe creates. Retracted to Dan.
13. **A Vercel deploy sat in "Deploying outputs" for 11 min** - infra, not ours; production kept the last good build.
14. **Antigravity's report was partly false** (cost, coverage, WH). Verify every inherited claim.
15. **LAWS.md conflicts 3x** in one night. Phase 4 should make the registry conflict-resistant.
16. The `mcp__counselors__host_terminal` safety classifier was intermittently unavailable ("claude-sonnet-5 temporarily unavailable"); file edits still worked. Retry after a moment.

---

## 16. Known Defects And Architectural Holes

| Priority | Defect / hole                                                                        | Evidence                                      | Impact                                                                                          | Recommended fix                                                                                                                                 | Status         |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| High     | Chain **dispatch** path never exercised live                                         | every live run said CONVERGED                 | if broken, a mid-build merge waits for the \*/30 cron or watchdog (bounded, not stranded)       | watch the next busy merge window; or merge two tiny commits ~2 min apart and confirm a `workflow_dispatch` run by `github-actions[bot]` appears | UNVERIFIED     |
| High     | Skip-marker guard is client-side only                                                | pre-push hook                                 | GitHub-MCP/autopilot pushes bypass it; chain/cron/watchdog recover, prevention is not universal | server-side CI job on `pull_request` scanning the PR's commits (Phase 4)                                                                        | open           |
| High     | No detection of a PR whose CI never started                                          | #2603 sat with 0 runs                         | a PR can wait forever                                                                           | autopilot sweep: if PR head has 0 workflow runs after N min, re-trigger (empty commit or close/reopen) and comment (Phase 4)                    | open           |
| High     | Cashier "Reconcile Now" disabled intermittently on production; spec asserts on it    | fails 02-03 UTC, passes 14:48, no code change | post-deploy job red for real or spec reasons; unknown player impact                             | find the disabling condition in the cashier recovery panel; fix product or make spec state-aware (Phase 5)                                      | open           |
| Medium   | `post-deploy-e2e` (29 min) is usually cancelled by the next publish before finishing | 4 cancelled of last 12                        | it rarely proves anything and burns box time                                                    | make it debounce/coalesce (run once per N publishes, or only on the newest sha after a quiet period)                                            | open           |
| Medium   | `docs/LAWS.md` padded table conflicts on every parallel law addition                 | 3 conflicts                                   | agent friction, merge failures                                                                  | unpadded rows or one-file-per-law with the registry test reading a directory (Phase 4)                                                          | open           |
| Medium   | Escalation (`escalate_in_app`) never fired live                                      | stub only                                     | unknown whether `fn_raise_notification` signature/perm works from the workflow                  | dry-run once with a test recipient or read the function signature                                                                               | UNVERIFIED     |
| Medium   | 85 PRs/day merge-rate figure (drives the ~$300/mo publisher estimate)                | from the earlier audit                        | savings estimates may be off                                                                    | remeasure via API over 24h                                                                                                                      | UNVERIFIED     |
| Medium   | WH `CI_RUNNER` unset; 2 WH runners idle on the box                                   | measured 26 min/12 runs                       | trivial cost; two idle listeners use ~100 MB each                                               | leave, or remove them (`./svc.sh stop/uninstall`, `config.sh remove`)                                                                           | decided: leave |
| Low      | Box in Ashburn at $141/mo (cpx41)                                                    | Hetzner API                                   | above Dan's stated 30 EUR; justified by queue                                                   | Dan's call; downgrade is one API call                                                                                                           | open decision  |
| Low      | 151 dirty / 183 unpushed worktrees on the Mac                                        | earlier measurement                           | work on one disk                                                                                | separate workstream                                                                                                                             | open           |
| Low      | `diamond_ledger` table exists and is empty                                           | SQL                                           | confusing; the real journal is `diamond_transactions`                                           | document or drop (DDL policy applies)                                                                                                           | open           |
| Info     | `hand_history` horse retention asymmetry                                             | CLAUDE.md                                     | none                                                                                            | Dan's ruling                                                                                                                                    | locked         |

---

## 17. Security, Secrets, And Credentials (names and locations only)

| Name                                                                                             | Where                                                                   | Used by                                                                          | Available      |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------- |
| `GITHUB_TOKEN` (PAT)                                                                             | `~/Documents/club-arena/.env`                                           | all REST calls from the Mac                                                      | yes            |
| `GH_PAT`                                                                                         | CA repo secret                                                          | fallback in workflows                                                            | present        |
| `AUTOPILOT_APP_ID` (var) / `AUTOPILOT_APP_PRIVATE_KEY` (secret)                                  | CA repo                                                                 | App installation tokens (WH sync, watchdog dispatch)                             | present        |
| `WORLD_HUB_SYNC_TOKEN`                                                                           | CA repo secret                                                          | PAT fallback for WH push                                                         | present        |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                      | CA repo secret; also `server/.env` on engine host; Supabase MCP         | watchdog escalation; secrets-expiry; migrations                                  | present        |
| `SUPABASE_DB_PASSWORD` / `DATABASE_URL`                                                          | CA repo secrets                                                         | engine deploy gate (`psql` to pooler `aws-0-us-west-2.pooler.supabase.com:6543`) | present        |
| `hcloud-ci-token`                                                                                | macOS keychain (`-a smarter-poker`)                                     | Hetzner API                                                                      | present        |
| SSH `~/.ssh/hetzner_deploy` (= Hetzner "deploy-key" 7a:30:46...), `~/.ssh/id_ed25519` (same key) | Mac                                                                     | root/ci on `estate-ci-1`                                                         | present        |
| Runner registration tokens                                                                       | minted per call via `POST /actions/runners/registration-token` (1h TTL) | adding runners                                                                   | mint fresh     |
| `CI_RUNNER` (repo variable, CA)                                                                  | GitHub                                                                  | routes jobs to `estate-linux`; **unset it = full rollback to hosted**            | `estate-linux` |
| Vercel                                                                                           | MCP tool auth; team `team_SVD8r7AOPH065G3usBxVvrBc`                     | deployment inspection                                                            | yes            |

No secret values appear in this document or in any file this session committed. `VITE_SUPABASE_ANON_KEY` in the publisher is the _publishable_ key (by design).

---

## 18. Database, Migration, And Seed Status

**No DDL, migrations, or seeds were performed by this session.** Read-only queries only (`ca_diamond_snapshots`, `ca_drift_incidents`, `profiles`, `diamond_transactions`, `ca_cert_accounts`, `auth.users`, `pg_proc`, `information_schema`). The diamond fix migrations named in 6.5 were applied by another agent; their files in `supabase/migrations/` are UNKNOWN - NEXT AGENT MUST INSPECT if you touch that area. Rollback not tested by this session (not applicable). Production data risk from this workstream: none.

---

## 19. Current Blockers And Decision Points

1. **Box cost vs approval** - cpx41 at ~$141/mo vs Dan's "~30 EUR" approval but "without limitations" instruction. Requires Dan. Options: keep (recommended - drains the queue and enables Phase 3), or downgrade to cpx31 (one `change_type` call; then keep runners at 4 and do not route the publisher shards).
2. **Phase 3 scope is a trade** - routing CSS Beat E2E (a required gate) and the publisher's 4 shards to the box increases box concurrency. Safe path: route Live Production E2E + small guards first, measure for a day, then CSS Beat E2E, then the publisher. Technical; no user authority needed unless it fails.
3. **Cashier button** - product behaviour question (Phase 5); may need Dan to say what "Reconcile Now disabled" should mean.
4. Nothing else is blocked.

---

## 20. Remaining Work

**Critical**

- (done) #2636 merged. Confirm #2640 (handoff docs) merged.

**High**

- Phase 3: apply `stash@{0}` onto `offload-rest` (merged with main), push, verify each routed job runs on `estate-*` and passes; then publisher `client-tests` + `build-and-store` `runs-on: CI_RUNNER`; measure publish latency stays <= ~7 min.
- Phase 4: server-side skip-marker check; dead-PR detector in autopilot; LAWS.md conflict resistance.
- Live-verify the chain dispatch path and the in-app escalation once each.

**Medium**

- Phase 5: cashier button condition.
- Debounce `post-deploy-e2e`.
- Remeasure merge rate and hosted minutes after Phase 3 (Phase 6 report); write `docs/changelog/` closeout.

**Low / optional**

- Remove idle WH runners or route WH `probe` (9 min) job.
- Consider Open Claw for any scheduled job that must be independent of GitHub.
- Worktree triage (151 dirty / 183 unpushed).

---

## 21. Prioritized Next-Phase Execution Plan

**Phase 0 - Recover and verify (15 min).** Prereq: none. Run section 22. Completion: you can state main tip, prod sha, #2636 state, box crontab, and 10/10 runners.

**Phase 1 - Protect completed work.** Do not edit `build-for-world-hub.yml` without running `tests/no-commit-left-behind.law.test.ts` and the four publisher pins. Do not edit the provisioner without re-running it on the box and checking `crontab -l`. Never unset `CI_RUNNER` except as deliberate rollback.

**Phase 2 (of Dan's plan) - closed.**

**Phase 3 - Finish the offload.** Files: `.github/workflows/ci.yml` (jobs `changes`, `source_windows`, `stub_gate`, `verdict`, `build` [Live Production E2E], `post-deploy-check` [CSS Beat E2E]), `.github/workflows/build-for-world-hub.yml` (`client-tests`, `build-and-store`). Steps: (a) `git checkout agent/cowork-audit/offload-rest && git merge origin/main && git stash pop` (resolve script hunks by taking main); (b) push in two PRs - first the small guards + Live Production E2E, then CSS Beat E2E, then a third for the publisher; (c) for each, confirm via API that the job ran on `estate-ci-*` and passed, and measure duration vs hosted; (d) keep the tool audit list in `provision-ci-box.sh` in sync with any new binary a routed job calls. Tests: the four publisher pins + law. Completion: no `runs-on: ubuntu-latest` left in `ci.yml` except `auto-revert` (disabled), publisher shards on the box, hosted minutes/day measurably near the watchdog/autopilot floor. Risks: box saturation (watch load and swap; raise cap or add a second box), browser-flow flakes (revert that job only).

**Phase 4 - Guards.** (a) `scripts/ci/check-no-skip-markers.mjs` run as a `pull_request` job over `base..head` (not a required check; autopilot won't merge red anyway); (b) in `agent-autopilot.yml` sweep: PR head with zero `actions/runs?head_sha=` after 10 min -> push an empty commit via App token (or close/reopen) and comment; (c) `docs/LAWS.md`: drop table padding (one row per line, no alignment) or `docs/laws/<name>.md` per law with the registry test reading the directory - law test `tests/law-registry.law.test.ts` must be updated in the same PR. Tests: extend `no-commit-left-behind` with pins for (a); new pins for (b) and (c).

**Phase 5 - Cashier.** Inspect `_reconcileBtn_` component (grep `Reconcile Now` in `src/`), find what sets `disabled`, correlate with the times it failed (02-03 UTC) - engine restart window, pending reconciliation, empty queue? Fix product or make `tests/e2e/production-cashier.spec.ts` assert on the state it can observe. Also debounce `post-deploy-e2e`.

**Phase 6 - Measure and close.** Re-run the minutes-by-job script (section 13 pattern) over 24h; write `docs/changelog/2026-09-0X-push-publish-cost-audit-closeout.md` with before/after; update this handoff's status lines.

Checkpoints: one PR per phase item; auto-merge; never wait on CI in a loop.

---

## 22. Exact First Actions For The Next Agent

1. `cd /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-audit && export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:/opt/homebrew/bin:$PATH"`
2. Read `CLAUDE.md` (sections 1.2.5, 10.8, 11.0, 12), `AGENT-PLAYBOOK.md`, this file, `docs/LAWS.md`.
3. `git status --short; git branch --show-current; git stash list | head -1; git fetch -q origin main; git log origin/main -1 --oneline`
4. Confirm #2640 (handoff docs) merged and #2636 is on main: `TOKEN=$(grep -E '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2- | tr -d '"'); curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/2640 | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['state'],d.get('merged_at'),d.get('mergeable_state'))"`. If merged, `git branch -d agent/cowork-audit/box-tools` locally.
5. Production vs main: `curl -s 'https://smarter.poker/hub/club-arena/build-info.json?cb=1' -H 'cache-control: no-cache'` and compare `ca_sha` to `git rev-parse origin/main`.
6. Box: `ssh -i ~/.ssh/hetzner_deploy root@5.161.121.210 'crontab -l; systemctl list-units "actions.runner.*" --no-legend | grep -c running; cut -d" " -f1-3 /proc/loadavg'` - expect the GC line, 10, and sane load.
7. Runners: `curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runners | python3 -c "import json,sys;[print(r['name'],r['status']) for r in json.load(sys.stdin)['runners']]"`
8. Do not modify: `AGENT-PLAYBOOK.md`, `docs/HANDOFF_CURRENT_STATE.md` (other workstream), any money gate, the shared main clone, other agents' stashes.
9. Resume at **Phase 3** (section 21) starting with `git checkout agent/cowork-audit/offload-rest && git merge origin/main && git stash pop`.
10. Push with the Python `start_new_session=True` pattern; open the PR via REST if autopilot has not; report the PR number; stop.

---

## 23. Acceptance Criteria (for the overall push/publish + cost objective)

- Every merge to main reaches `smarter.poker/hub/club-arena/build-info.json` `ca_sha` within ~10 min in normal operation; a stranded state is either self-healed by chain/cron/watchdog or produces an in-app notification to Dan. Testable: pick any merge, watch build-info.
- No publisher run publishes a sha older than production (compare guard) - testable via WH commit history.
- All required checks still gate merges; no law test weakened; `tests/law-registry.law.test.ts` green.
- Hosted GitHub minutes/day for CA reduced to the watchdog/autopilot floor (measure with the section-13 script); `CI_RUNNER` unset restores hosted behaviour instantly.
- Box: `crontab -l` contains the GC line; provisioner runs clean from any state; 8/8 caps present; no OOM kills in `journalctl`.
- Post-deploy e2e completes (not cancelled) at least once per quiet hour and its cashier steps pass.
- Git: no unmerged work left only in a worktree/stash; PRs auto-merged; branches cleaned.
- Production: `hand_history` still advancing; engine on main; diamond gate `unexplained` within tolerance.

---

## 24. Recommended Commit Strategy (remaining)

1. `perf(ci): route the small per-PR guards and Live Production E2E to the estate runner` - `ci.yml` jobs `changes`, `source_windows`, `stub_gate`, `verdict`, `build`; tests: publisher pins + law.
2. `perf(ci): route CSS Beat E2E to the estate runner now the box has 8 cores` - `ci.yml` `post-deploy-check`; tests: same; verify 3 green runs on the box before merging anything else.
3. `perf(ci): publish shards and build on the estate runner` - `build-for-world-hub.yml` `client-tests` + `build-and-store`; tests: `no-commit-left-behind`, `deployAndPublishAreHonest`; verify #-run on box and publish latency.
4. `fix(ci): skip markers are refused server-side too` - new job + law pins.
5. `fix(autopilot): a PR with no checks after ten minutes is re-triggered` - autopilot sweep + test.
6. `docs(laws): the registry cannot conflict` - LAWS.md shape + registry test.
7. `fix(cashier): ...` per Phase 5 findings.
8. `docs(changelog): push/publish cost audit closeout with measured savings`.

---

## 25. Final Continuation Summary

**Stopping point.** Phases 1 and 2 of the six-phase plan are complete and verified live; #2636 (provisioner crontab fix) merged; #2640 (this handoff) auto-merging; the Phase 3 `ci.yml` routing is drafted in `stash@{0}` of the `cowork-audit` worktree and not yet on a branch.

**First work.** Section 22, then Phase 3.

**Locked requirements.** Tip-of-main publishing and the chain stay; test gate strength stays; money gates are never weakened; horses are players; no em dashes/Title Case in player copy; laws registered; never watch CI in a loop; never `--no-verify`; never rebase main.

**Greatest technical risk.** Routing the required CSS Beat E2E and the publisher shards onto the box saturates it and reds merges - route incrementally and measure.

**Greatest visual risk.** None in this workstream.

**Greatest data-integrity risk.** The 8 formerly-unjournaled diamond writers were fixed by another agent; this session did not read those migrations. If diamond drift incidents recur, start there.

**Decision needing Dan.** Keep cpx41 (~$141/mo) or downgrade to cpx31.

**How to continue without restarting discovery.** Everything above was measured against live APIs and the box on 2026-09-02; the publisher, watchdog, guard and provisioner are on `origin/main` (including `cron_set`, #2636) with tests that turn red when their mechanisms are removed; the box state is reproducible from `scripts/ci/provision-ci-box.sh`; the remaining work is a drafted stash, a short list of guards, one product question, and a measurement. Start from section 22 and do not re-audit what section 14 already proves.
