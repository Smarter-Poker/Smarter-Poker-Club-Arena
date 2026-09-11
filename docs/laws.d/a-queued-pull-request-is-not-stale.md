# tests/a-queued-pull-request-is-not-stale.law.test.ts

The former scheduled stale-label and queue-reconciliation writers were
retired. Pull-request state now advances only through native GitHub events,
required checks, and branch protection. The law pins that `stale.yml`, the
queued-label mutator, and automatic PR-close commands remain absent; it also
pins the event-driven `pull_request_target` entry point used by Autopilot.

This removes the failure mode where a periodic classification guessed wrong,
relabelled reviewed work, or closed it behind the author. A red or conflicted
pull request remains visible for a person to resolve; no background reconciler
rewrites its lifecycle.
