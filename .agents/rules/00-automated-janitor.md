---
description: Local recovery automation is retired; preserve and ship only through reviewed branches.
trigger: always_on
---

# NO LOCAL JANITOR OR AUTOMATIC RECOVERY WRITES

Do not install or run a local watcher, cron, reconciler, or janitor that commits,
pushes, rewrites, deploys, or recovers another worktree. Such automation cannot
know ownership and previously bypassed repository hooks.

Each agent preserves its own work on an isolated feature branch, stages only
explicit paths, runs the gates, and pushes normally. Server-side pull-request
checks and protected branch rules decide whether it can merge. Club Arena's own
Hetzner workflows publish merged code and prove the served SHA.

If abandoned work is discovered, inspect it read-only and notify its owner. Do
not mutate it automatically.
