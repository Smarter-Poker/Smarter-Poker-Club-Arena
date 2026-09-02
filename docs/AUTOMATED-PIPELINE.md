# 100% Automated Deployment Pipeline

This repository is governed by an entirely decoupled, multi-layered architecture designed to prevent stranded code, stale pull requests, and deployment lag. It is built to support extreme velocity (100+ commits/day) and multi-agent concurrency.

## Layer 1: The Local OS Janitor

**Where:** `scripts/agent-recovery-janitor.sh` (triggered by macOS `crontab` every 30m)
**Purpose:** Prevents local work from being destroyed by `git reset --hard origin/main`.
**How it works:**

1. Scans all `.agent-trees/`.
2. Leaves active work (touched in the last 2 hours) strictly alone to prevent hijacking.
3. Takes abandoned work, commits it, pushes it to `recovery/*`, and opens a Draft PR so GitHub preserves the code.

## Layer 2: Agent Open PR

**Where:** `.github/workflows/agent-open-pr.yml`
**Purpose:** Rescues agents that successfully pushed to GitHub but were blocked from running `gh pr create` (e.g. proxy blocked API).
**How it works:** Intercepts any new `agent/*` branch creation on GitHub and automatically opens a PR for it.

## Layer 3: Agent Autopilot

**Where:** `.github/workflows/agent-autopilot.yml`
**Purpose:** Removes the need for agents to manually poll CI and merge their own work.
**How it works:**

1. Enables Squash Auto-Merge instantly on open PRs.
2. Keeps branches automatically rebased and fresh against `main`.
3. Merges automatically the second the required checks (TypeScript, Vitest, Playwright, Build) pass.

## Layer 4: The Stuck Sweep

**Where:** `.github/scripts/report-stuck-prs.sh` (runs inside Autopilot `*/20` schedule)
**Purpose:** Prevents rotting code (the "Revert Trap").
**How it works:** If a PR fails a check, encounters a conflict, or sits open without merging, it sweeps the repository and creates a GitHub Issue alerting agents that human/AI intervention is needed.

## Layer 5: Publish Watchdog

**Where:** `.github/workflows/publish-watchdog.yml`
**Purpose:** Proves code actually reached production, rather than just merging into `main`.
**How it works:** Curls Vercel (`build-info.json`) every 15 minutes. If Vercel is serving an old SHA, it triggers an automatic retry of the deployment pipeline. If it still fails, it opens a high-priority GitHub Issue.
