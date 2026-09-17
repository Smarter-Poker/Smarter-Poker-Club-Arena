# Agent playbook

Read [AGENTS.md](AGENTS.md) first, then the full references in [the reference index](docs/agent-policy/REFERENCE-INDEX.md). [The operating law](docs/agent-policy/OPERATING-LAW.md) owns scope, resumption, blocker recovery and productive waiting. [The hardening standard](docs/agent-policy/HARDENING.md) owns implementation and regression protection. [PUBLISHING.md](PUBLISHING.md) owns the approved delivery route. Product and financial rules in `CLAUDE.md`, where present, still apply.

## Preserve work and authority

Recover the assigned worktree, branch, PR and evidence. Use an owned linked worktree; a unique writable directory on `/Volumes/SmarterWork/agent-work` is permitted when mounted. Do not reset, clean, stash, move or commit another task's changes. Stage explicit paths and use normal hooks and the configured Git identity. Resolve conflicts by inspecting both sides; never blanket-accept one side or force-push main. Integrate current main into the owned branch when needed and revalidate affected evidence.

Use configured Git/GitHub tools; verify availability in the current environment. Prefer authenticated CLI/API tools for repository operations, with other authorized tools when needed. An unavailable interface is not proof that all access is unavailable. Never read `.env` values or scrape tokens from remotes, documents or sibling repos.

## Read the actual check result

Use `node scripts/ci/pr-status.mjs <PR-number>` or the authenticated Actions API for the exact head revision. `GET /commits/:sha/status` reports legacy commit statuses and can say pending with zero results even when Actions has failed. A denied `/commits/:sha/check-runs` read is UNKNOWN, never proof that no check failed. Read `/actions/runs?head_sha=<sha>` and its jobs to identify the actual result. On this Mac `/opt/homebrew/bin` must be on PATH for the configured `gh` executable; check the current environment before declaring it unavailable. A green check still requires the authorized agent to complete protected merge and publication under PUBLISHING.md.

## Complete the assigned result

Do not stop at a push when authorized delivery is unfinished. Find or create the PR, pass applicable checks, complete protected merge, and verify the actual publication and behavior. Reuse a remote commit or PR already present. If its PR has merged, a new follow-up needs an owned branch and PR; pushing into a closed PR does not deliver it.

Failed delivery enters immediate blocker recovery under the operating law. Compare the last successful equivalent, fix the cause, validate affected inputs and promptly continue through the existing route when eligible. Unknown remote outcome requires readback before retry. Keep pending work and remaining verification in the existing checkpoint. Never bypass a failing gate or add a release timer, watcher or recurring agent.

Evidence must match the actual inputs and component. A merge badge, successful command, open PR, frontend version or filled form is not proof of every downstream result. For a write, read back the persisted row and affected consumer safely. Prove inclusion when a newer protected version contains concurrent work; do not overwrite it to force an older SHA.

## Preserve product rules

The owner's ban on “em bars” means em dashes in user-visible text, not hamburger navigation icons. Preserve approved navigation, financial safeguards and task-specific product laws. Do not use real chips or active games for destructive tests. Unrelated TODOs are not an assignment, and unavailable verification must be reported rather than invented.
