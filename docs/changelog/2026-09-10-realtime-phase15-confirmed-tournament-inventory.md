# Phase 15: Confirmed Tournament Inventory

## Problem And Repair

A warm club lobby could keep its final tournament card indefinitely after a
successful empty tournament read. The full load refused every empty answer,
while the fast RPC stopped writing after the first list was painted. The old
guard protected against a degraded union lookup narrowing the query scope;
removing that guard without proving scope would revive the earlier blank lobby.

The full load now clears tournaments only after a successful array response
and confirmed scope. A fresh union membership or fresh club union identifier
confirms union scope. Standalone scope requires a successful null membership,
a null club union identifier, a non-union-house club and readable empty cache.
Legacy nullable is_union remains supported. Query errors, null data,
cache-only fallbacks and unresolved scope preserve the last visible list.

A newer joinable realtime INSERT or UPDATE contradicts an older empty query.
The callback advances a revision, and the empty-result path queues the existing
coalesced reload owner. The next authoritative read resolves the inventory.
Completed or out-of-scope updates do not provoke another read. Reporting and
reload decisions execute outside React state updater functions.

## Reproduction And Validation

Baseline: c41635319207842a45b9dc65d87ba9f00da130ed.
The mounted suite reproduced seven failures with 19 passing cases before the
source repair. All seven failures concerned stale-card removal or the missing
authoritative follow-up after a realtime insertion. Initial fixture failures
were excluded from this reproduction evidence.

After repair, the mounted suite passes all 26 cases, including the 14 preserved
Phase 13/14 cases. The 15 shared-scope contracts and 24 anti-flicker contracts
also pass. The storage-failure fixture intercepts the storage global and asserts
that the cache read occurred; spying on the environment's storage instance or
prototype did not intercept it. The unrelated wallet component is isolated in
this mounted lobby fixture; the actual page, cards, callbacks and reads run.

The required TypeScript check (npx tsc --noEmit) and production build
(npm run build) both passed on September 10, 2026.

## Boundaries And Acceptance

The repair uses existing lifecycle ownership; it adds no cron, polling loop,
subscription, dependency or database migration. Engine/container/tag/host
checkout and Stage-B DDL remain with the separate release coordinator.
Phase 14 exact publication evidence is preserved in
docs/audits/2026-09-10-realtime-phase14-release.md and its adjacent JSON.

Phase 15 publication was verified after normal auto-PR, CI, autopilot and
publisher completion. Exact public/origin stamps, referenced asset hashes and
matching released source are recorded in
docs/audits/2026-09-10-realtime-phase15-release.md. Natural reconnect, production
UI and physical iPad/PWA acceptance remain open; the receipt records those limits.
