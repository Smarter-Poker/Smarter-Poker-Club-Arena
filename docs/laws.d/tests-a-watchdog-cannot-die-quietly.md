# tests/a-watchdog-cannot-die-quietly.law.test.ts

Release and merge automation carries no long-lived PAT fallback and no mutating recovery watcher. The retired publish, engine, orphan-work, stuck-PR, and schedule-liveness watchers remain absent; the surviving production-provenance audits are read-only and cannot dispatch releases or toggle workflows.
