# Publish Gate: Seat-First Joinability Contract

## Finding

The World Hub sync correctly refused to publish because two source-contract tests still required the retired `withTable` identifier. The engine had already strengthened that rule: a seat-first tournament only covers a board slot when its table is joinable, not merely present. A closed table is a husk and cannot accept a player.

## Fix

- Updated both incident guards to require `isJoinableTableRow`.
- Updated both guards to require the active `withJoinableTable.has(r.id)` board filter.
- Kept the stronger engine behavior intact; no production runtime logic was weakened to satisfy a stale test.

## Verification

- Both focused incident suites pass.
- The exact publish command, `npx vitest run tests/`, is required to pass before the corrected bundle is synced.
