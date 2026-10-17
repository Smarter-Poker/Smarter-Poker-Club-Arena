# Cloud agents reach the migration installer (2026-10-16)

## What was wrong

1. `apply-merged-migration.yml` only answered `workflow_dispatch`. That needs
   the Actions write scope, and the GitHub App integration cloud agents use
   answers it with 403 "Resource not accessible by integration". So every
   merged migration from a cloud agent was retyped into the Supabase MCP's
   `apply_migration` - the hazard the installer was built to remove.
2. `scripts/reserve-migration-version.sh` tried `stat -f %m` before
   `stat -c %Y`. On Linux GNU `stat -f` means "filesystem status", prints a
   multi-line report and exits 0, so the report reached `$(( ))` and the
   script died "File: unbound variable" before reserving anything. Cloud
   agents had to skip the fetch by hand to get a version.

## What changed

- The installer has a second door, `repository_dispatch` with event type
  `apply-merged-migration`, reachable with contents:write. The payload carries
  only `migration` and `dry_run`; the index recovery, final-table, thaw-repair
  and report-history options stay on `workflow_dispatch` alone. The applier and
  every guard it runs are the same for both doors. The payload is read through
  `env`, never interpolated into a script.
- The reserver accepts a `stat` answer only when it is a bare number of
  seconds, trying GNU form first, then BSD.

Pinned in `tests/unit/applyMergedMigrationVerdict.test.ts`.

## How to use it

```
POST /repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches
{"event_type":"apply-merged-migration","client_payload":{"migration":"<file>.sql","dry_run":true}}
```

The run's job summary is the answer, exactly as for a workflow_dispatch run.
