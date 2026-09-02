# Table Management Published Contracts

## Phase

Phase 2 of 6: Version and lock published game contracts; validate guarantees.

## What Changed

- Added append-only contract history for every cash table and tournament. Each
  revision has a monotonic version, canonical JSON document, SHA-256 hash,
  publication time, actor, and reason.
- Backfilled version 1 for existing games and added database triggers so every
  new game and advertised configuration change is captured automatically,
  including games created by recurring tournament services.
- Locked operator tournament contract changes after the first registration.
  The lock counts every tournament player row, including horses, system
  players, and nullable-user entries.
- Preserved deterministic service-role lifecycle adaptations, such as fitting
  a payout ladder to the final field, as visible system-authored revisions
  instead of making those engine operations fail silently.
- Added a server-authoritative tournament readiness calculation covering
  contract completeness, current prize pool, required overlay, funding bank,
  bank floor, other live guarantee exposure, and any remaining shortfall.
- Revalidated guarantees at publication and again at the transition to
  `RUNNING`. The calculation uses the union bank for union clubs and the club
  treasury for standalone clubs, matching the settlement funder.
- Added governed RPCs for batched contract summaries and bounded revision
  history. The underlying table has RLS enabled and grants no direct browser
  access.
- Added contract version, hash, lock, and readiness badges to every Table
  Management row, plus an operator history dialog with funding telemetry and
  the complete immutable record.
- Changed live-table editing so structural inputs visibly lock while the name
  remains editable, matching the server behavior instead of silently ignoring
  submitted structural changes.

## Verification

- Added source-law coverage for append-only history, hash/version guarantees,
  participant locks, RPC authorization, bank selection, publish/start gates,
  and management UI wiring.
- Parsed the migration with PostgreSQL SQL and PL/pgSQL parsers.
- Focused Table Management, lifecycle, and published-contract tests pass.
- TypeScript typecheck, targeted ESLint, title-case, painted-text, and diff
  checks pass. Full-suite, production-build, provenance, and main-sync results
  are recorded in the phase handoff.

## Realtime Law

Contract edits continue to publish the existing explicit `TABLE_UPDATED` and
`TOURNAMENT_UPDATED` MasterBus events. Cross-device database publication is
reserved for Phase 4; no polling or snapshot-diff gameplay path was added.

## Deployment

The migration is committed for the deployment pipeline. It was not applied to
the linked database and no deployment was performed from this worktree.
