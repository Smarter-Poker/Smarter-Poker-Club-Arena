# Phase 14: Lobby Inventory And Waitlist Recovery

The parallel audit is bounded to client lobby recovery. Engine release sealing,
container changes and Stage-B DDL remain with their coordinating task.

## Repairs

- Occupancy reads have one in-flight owner per active channel setup. Slow reads
  cannot overlap and arrive out of order. A failure releases the owner.
- Inventory recovery is decided outside React state updaters, which may be
  deferred or replayed. An unknown occupied table requests a full refresh.
- A known table missing from an uncapped read requests authoritative recovery
  only when it belongs to that query's scope. Omission never directly deletes
  a card. Capped and narrower union-scope results cannot trigger a reload loop.
- The full table projection keeps its existing scope columns so recovery can
  classify union games even when the fast snapshot did not populate them.
- The open game drawer refreshes its waitlist after a confirmed join or leave.
  Failed mutations retain the verified queue without redundant refetches.

These changes use existing component lifecycle and query paths. They add no
cron, subscription, database migration or engine message type.

Validation and exact publication evidence are recorded with the release.
Physical iPad/PWA and natural reconnect acceptance remain unverified.

## Audit Boundaries And Next Scoped Finding

At 03:08:04 UTC on September 10, the publication still contained six tables;
`tables`, `tournaments` and `bbj_winners` were absent. The current engine lobby
message contains online counts, not inventory. The existing table metadata
message describes blind changes on individual table sockets. Neither is
claimed as a working lobby inventory feed by this release.

New empty games retain the deliberate 90-second full refresh cadence. A warm
successful tournament query returning an empty list can retain previous rows
indefinitely. Its historical protection also prevents real scope failures from
blanking a union lobby. The next phase needs a mounted regression distinguishing
confirmed empty scope from failed scope before changing that protection.

## Local Regression Evidence

Original inventory code: 3 failed and 11 passed mounted tests. Original drawer:
4 failed and 1 passed. After repair, the integrated mounted suites passed 27
of 27 tests, including the eight existing drawer observer tests. The five
existing lobby/scope contract files passed 69 of 69 tests. These are 96 focused
tests across eight files. `npx tsc --noEmit` exited 0 on the integrated source.
The test harness now supplies a null auth session for the cached lobby's closed
wallet modals; mock setup errors are not counted as product regressions.

The local bundle attempt stopped after transforming 3,008 modules because the
Mac volume returned `ENOSPC` during Rollup writes. This is not a successful
build. Only this task's incomplete dependency copies and generated build
outputs were removed. Required CI and publisher builds must close that gate.
