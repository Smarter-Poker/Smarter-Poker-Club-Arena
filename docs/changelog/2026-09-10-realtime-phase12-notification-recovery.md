# Phase 12: Notification Feed Recovery

The routed NotificationsPage could paint another account's legacy cache, accept a retired read, lose invalidations, mistake refused reads for an empty inbox, and undo refusal recovery with its dismissal timer. Nine mounted regressions reproduced those failures.

The feed now belongs to one account and lifecycle. Confirmed rows alone warm that account's cache. Subscription recovery and visibility invalidate a coalesced fresh read; stale responses cannot commit over newer invalidations or pending mutations. A failed refresh preserves confirmed rows and exposes retry. Connection status follows actual subscription status.

Two further mounted regressions reproduced the warm server-cache recovery gap and page notifications being sent to the social notification table. Reads now use the existing authenticated social/page APIs, reconcile after both owners settle, and do not claim all-read on partial refusal. Dismissal waits for acknowledgment. Synthetic page dismissals remain local.

World Hub's matching change checks all four required database reads, refuses to cache partial/failed feeds, restricts interpolated follow identifiers using its existing poker-route boundary, and makes bounded mark-all select the latest page notifications.

## Publication Root Cause And Repair

Migration 20260908031934 used ALTER PUBLICATION SET TABLE while changing club_members columns. That replaced unrelated memberships. On September 10, notifications was absent while the routed page still subscribed to it. The five existing publication entries must not be described as proof of an intentional, complete transport migration.

Production notifications retained owner-only SELECT RLS and had 113 inserts in the preceding 24 hours. Migration 20260910003525 restores only that proven caller with ADD TABLE, preserves every other table and column list, and aborts if the verified privacy policy changes. It adds no cron, row mutation, policy, or engine restart.

Applied once at 00:35 UTC September 10. Post-apply inspection at 00:35:55 UTC found six publication tables, unchanged owner-only notification RLS, and unchanged security/performance advisor counts. The migration list records the exact applied version.

## Verification And Limits

Client: mounted recovery/account/mutation/lifecycle contracts in tests/unit/notificationFeedRecovery.test.tsx. Server: six failures reproduced before repair, then 46 handler, route, and copy tests passed. PostgreSQL 17: actual migration, additive membership, repeat application, unchanged column restrictions, both account reads, anonymous denial, and refusal of broadened RLS passed in an isolated cluster.

No live notification was inserted, read, dismissed, or delivered as a test. Publication membership is not physical-device delivery evidence. Public client bytes, World Hub production adoption, and the live UI must still be recorded in the release evidence. Physical iPad/PWA acceptance remains open.
