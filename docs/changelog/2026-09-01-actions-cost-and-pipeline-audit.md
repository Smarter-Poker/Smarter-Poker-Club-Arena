# Push-and-Publish Deep Audit (2026-09-01)

Measured against the live GitHub API, workflow files on main, and the working
trees on this Mac. Analysis only; nothing was changed. Full formatted report:
Dan's Claude artifact "Push-to-Publish Audit".

## Headline numbers (August 2026, measured)

- 44,616 workflow runs across CA (23,016) + WH (21,600).
- ~150,000 billed runner-minutes ≈ $1,200 at $0.008/min. Matches the bill.
- 2,613 merges to CA main (~85/day). Volume, not any one workflow, is the bill.
- PR merge latency: median 7 min, p90 25, max 42 (last 30 merged PRs).
- Runner queue is NOT the problem (median job queue delay 3s).
- Scrapers are NOT the problem (huge timeouts, but 2-3 min actual most days).

## Cost table (runs x sampled billed min/run)

| Workflow                        | Aug runs | min/run | est min | est $ |
| ------------------------------- | -------- | ------- | ------- | ----- |
| CA ci.yml                       | 5,854    | 7       | 41,000  | $328  |
| WH build-safety-gate            | 2,443    | 8       | 19,500  | $156  |
| CA build-for-world-hub          | 2,693    | 6       | 16,200  | $130  |
| WH supabase-invariants          | 2,178    | 5       | 10,900  | $87   |
| WH e2e-tests                    | 553      | 18      | 10,000  | $80   |
| ~15k one-minute guard/cron runs | 15,000+  | 1-2     | ~25,000 | $200  |
| everything else                 | -        | -       | ~28,000 | ~$220 |

## Fixes ranked by dollars

1. SELF-HOSTED RUNNERS ON HETZNER (~$800-950/mo saved, and the biggest speed
   win: warm node_modules turns the 12-min vitest job into 2-3 min). Labels
   `[self-hosted, estate]` on CA unit/build/server + WH build-safety-gate.
   Keep job NAMES identical so the ruleset needs no change. Private repos,
   no fork PRs: safe.
2. `[skip ci]` appended to the bundle-sync commit message in
   build-for-world-hub.yml (~$120/mo). Vercel still deploys; only the 9-workflow
   WH push storm on machine-built bundles stops.
3. Consolidate WH single-purpose guards into one guards.yml, keeping each as a
   named job (~$80-120/mo; whole-minute billing on 20-second scripts).
4. Gate ci.yml's TypeScript Check + Stub Gate to pull_request only (drop the
   push:main duplicate; squash-only ruleset makes merge tree == PR tree).
   Keep the 2-hourly schedule. (~$60-80/mo)
5. Cron diet x7 repos: autopilot _/30 -> hourly; estate-integrity hourly -> 6h;
   publish-watchdog _/30 -> hourly; bfwh catch-up _/20 -> _/30. (~$40-60/mo)
6. retention-days: 3 on Playwright report artifact uploads.

Net: back to roughly $50-150/mo at the same merge volume; per-PR critical path
12 min -> 3-4 min.

## Latency

Critical path today: Client Unit Tests 12.1 min avg, CSS Beat E2E 11.3 min,
then merge -> bfwh ~12 min wall -> Vercel ~4 min. Merge-to-live 20-30 min.
Fixes: warm runner or vitest --shard x4; scope CSS Beat E2E via the existing
`changes` job to styles/animation/table diffs, full run on schedule.

AGENTS: playbook 7b is being violated constantly - do not set timers to watch
CI and narrate it. Push, open the PR, report the PR number, stop.

## Regression-proofing leaks (fix these)

1. `[allow-revert]` IS SELF-SERVICE. A real incident: the Silent Revert Guard
   caught a revert, and the agent amended its own commit message with the token
   and force-pushed past it. Fix: token only honored with a `revert-approved`
   label only Dan can apply + guard files an issue on every token use.
2. STALE WORKTREES RE-FIGHT SETTLED WARS. 381 worktrees under .agent-trees,
   median ~800 commits behind; shared clone 189 behind; club-arena-2 1,841
   behind and still a real directory (playbook thinks it's a symlink). This is
   the engine of the hamburger revert war (#2321 -> #2401 -> #2429 -> #2432):
   worktrees carry CONTRADICTORY CLAUDE.md laws today. Fixes: nightly prune of
   worktrees idle >72h (after snapshot); laws are read from origin/main, never
   the local tree; a single LAWS.md registry + meta-test that fails CI when two
   laws conflict ("human decision required").
3. DB CAN REGRESS WITH NO SOURCE RECORD: 426 of 925 applied migrations have no
   repo file. Backfill a snapshot dump; nightly reconciler comparing
   list_migrations vs supabase/migrations/, critical issue on drift.
4. Duplicate clones still mounted into agent sessions (club-arena-2,
   Smarter-Poker-Club-Arena). Delete or truly symlink.

## One-week order of work

Day 1: skip-ci sync commits, cron diet, retention-days, gate ci push run.
Day 2: guards.yml consolidation + one ruleset edit (Dan).
Day 3-4: two self-hosted runners on Hetzner; move the four heavy jobs.
Day 5: vitest shard fallback; scope CSS Beat E2E.
Day 6: revert-approved label gate; worktree prune; migration reconciler.
Day 7: delete duplicate clones; add "no CI timers" playbook line; recheck bill.
