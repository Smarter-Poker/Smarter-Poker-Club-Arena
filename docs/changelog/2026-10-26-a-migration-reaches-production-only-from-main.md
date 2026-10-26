# 2026-10-26 - A migration reaches production only from protected main

Owner instruction, 2026-10-25 22:07 America/Chicago, on the follow-up of how
production came to run migrations main had never seen: "do what ever you feel
needs to be done for phase 2".

## What happened

On 2026-10-24/25 three migrations were applied to production from pull
requests that were still open (#7968, #7983, #8019). Production then held SQL
that main had never seen, `Installed and merged migrations agree` went red, and
the SQL had to be recorded by hand (#8109). The route the agents used was the
one this repo pointed at: `check-migrations-are-live.mjs` named the Supabase
MCP `apply_migration` as the remedy, and until #8012 (2026-10-25 07:56 UTC)
there was no automatic install after a merge, so applying before merging was
the fastest way to get a fix live.

## What changed

- `PUBLISHING.md` and `CLAUDE.md` (production DDL rule 11): a migration
  reaches production only from protected main. The autopilot's merge
  dispatches every added migration to `apply-merged-migration.yml`; after any
  other merge the agent dispatches it. Never apply from an unmerged branch, a
  local file or the Supabase MCP. The one exception is an active outage that
  cannot wait for required checks, and the agent that applies directly commits
  the byte-exact recording to main as its next step.
- `check-migrations-are-live.mjs` now names `apply-merged-migration` as the
  remedy for a merged-but-not-live file, not the MCP.
- `check-applied-migrations-are-recorded.mjs` says that each unrecorded
  migration also needs its cause found.

## Why not a database-level block

A trigger refusing DDL from the MCP's session would also refuse the documented
outage path, and the estate's sessions share the `postgres` role the applier
uses, so it could not tell the two apart reliably. The written rule, the
remedies that point at the applier, and the existing detector
(`Installed and merged migrations agree`) close the gap without that risk.

Pinned by `tests/unit/migrationsInstallFromMain.test.ts`.
