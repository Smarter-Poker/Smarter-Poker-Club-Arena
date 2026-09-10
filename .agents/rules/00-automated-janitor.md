# AUTOMATED JANITOR (DO NOT POLL, DO NOT RECOVER OTHERS' WORK)

You do NOT need to write cron jobs, polling loops, or manual recovery steps to protect your work or other agents' work. The repository has a 100% automated, decoupled Janitor system.

## 1. Local Protection

`scripts/agent-recovery-janitor.sh` runs automatically via local cron. It audits every per-agent worktree.

- **Active Work**: If a worktree has uncommitted edits younger than 2 hours, it is left completely alone.
- **Abandoned Work**: If a worktree has uncommitted/unpushed edits older than 2 hours, the Janitor automatically commits them with `chore(recovery): automatic backup`, pushes to a `recovery/*` branch, and opens a **Draft PR**.
  This prevents active builds from being hijacked while guaranteeing no work is destroyed by a `git reset`.

## 2. GitHub Protection

- **Stuck PRs**: `.github/workflows/agent-autopilot.yml` runs every 20 minutes to find PRs that are stuck (red checks, merge conflicts) and opens an issue.
- **Hetzner Origin Publishing**: `.github/workflows/publish-watchdog.yml` checks `https://smarter.poker/hub/club-arena/build-info.json` every 15 minutes. If a Club Arena commit merges but the Hetzner origin does not publish it, the watchdog automatically retries `publish-club-arena.yml` and/or opens a high-priority issue.

## Your Responsibility

Your ONLY job is:

1. Work in your own worktree (`agent-workspace.sh`).
2. Run your verification tests.
3. Commit and push (`git push -u origin HEAD && gh pr create`).
4. **Stop.**

Do not write polling loops. Do not attempt to recover other agents' abandoned directories manually. The Janitor handles it.
