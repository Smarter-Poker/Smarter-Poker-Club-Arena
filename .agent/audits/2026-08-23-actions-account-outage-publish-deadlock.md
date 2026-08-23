# 2026-08-23 — GitHub Actions account outage: every workflow dead, publishing deadlocked

## What happened

At 23:26 UTC on 2026-08-22, every GitHub Actions job in this repo began
failing **3-6 seconds after starting, with zero steps executed and no logs
retained**. Not one workflow — all of them: CI, Agent Autopilot, Silent
Revert Guard, Publish Watchdog, Estate Integrity, Build for World Hub Sync.
The last healthy publisher run built `5644d685e`; the run for `8c11d80a9`
(main HEAD, carrying the mobile fit sweep #326) had its build succeed at
6m39s and then its sync job die in 2 seconds.

githubstatus.com reported Actions **operational** at the time, so this is
account-local, not a platform incident. The uniform signature — instant
job-level failure, no steps, no logs, across every workflow in a **private
repo under a user account** — is what GitHub does when the account's Actions
spending limit / included minutes are exhausted. The PAT available to agents
cannot read the billing API (403), so the diagnosis stops one step short of
the invoice; the billing page will show it directly.

## What it deadlocks (all of it observed live)

- **PR merges everywhere**: required checks never report, Autopilot never
  merges. Both CA and WH rulesets require Actions-produced checks.
- **Publishing**: CA main moved past production and cannot publish. The
  Publish Watchdog — the self-heal for exactly this — is itself an Actions
  workflow, and is failing the same way.
- **Direct pushes**: WH `main` rejects pushes ("7 of 7 required status checks
  are expected"), so the manual sync path is also closed at the last step.

## What was tried, in order

1. `gh run view --log-failed` → "log not found" (no logs exist to read).
2. Manual publish: `sync-club-arena.sh` with `CA_SRC_OVERRIDE` pointed at a
   clean detached checkout of CA `origin/main` (8c11d80a9) and `WH_OVERRIDE`
   at a throwaway WH worktree. Build succeeded, gates passed, bundle stamped
   `built_by: sync-club-arena.sh`. Commit required the script's own
   `ARENA_BUILD=1` authorization (the script stages but no longer commits).
3. Push to WH `main` → rejected by the ruleset (above). The commit is
   preserved on WH branch **`manual-sync/ca-8c11d80a9`** instead.

## The one human action required

Raise the GitHub Actions spending limit (or add payment / confirm the plan)
on the Smarter-Poker account: Settings → Billing and plans → Usage. Nothing
agent-side can do this — it is a financial decision on an account only a
human controls.

## What happens on its own once billing is fixed

- The Publish Watchdog's next 15-minute tick sees production ≠ main and
  re-dispatches the publisher (self-heal, once per sha) — the automated
  pipeline publishes main HEAD without any hand-holding.
- Autopilot's next sweep merges every PR whose checks go green.
- The `manual-sync/ca-8c11d80a9` WH branch becomes redundant at that point
  and should be deleted (a rebuild of the same CA sha produces
  content-identical hashed assets, so it will conflict with nothing while it
  waits).

## Marginal notes for the next agent

- A job that fails with **no steps and no logs** is not your workflow file.
  Check `gh run list` across ALL workflows first; if everything is dying in
  seconds, stop debugging YAML and check account billing / githubstatus.
- The estate's guards are Actions-hosted, so an account-level Actions outage
  turns every self-healing mechanism off at once — the watchdog cannot watch
  itself. If this recurs, consider an off-GitHub uptime check on
  build-info.json staleness (Hetzner cron exists and is independent).
