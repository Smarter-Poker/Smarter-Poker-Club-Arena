# Phase 12 Release Verification

The notification feed repair is published in Club Arena and World Hub. Controlled Chrome renders the feed after both releases. Physical iPad/PWA acceptance and a naturally occurring notification event remain unverified; the wider realtime programme is not 100% complete.

## Repair And Regression Evidence

The routed page now owns its cache, requests, realtime invalidations, and mutations by authenticated account. It coalesces refreshes, re-reads on subscription and visibility recovery, refuses retired responses, preserves confirmed rows on read failure, and waits for canonical read/dismiss acknowledgement. Required Supabase session errors are handled explicitly. The API refuses four required feed-read errors, validates page-follow filter identifiers, and marks the newest bounded page notifications read. No cron was added.

The original mounted page reproduced nine lifecycle/refusal failures and two additional transport failures. The final mounted suite passes 20 tests. The original API handlers reproduced six failures; the repaired handler/copy/route suites pass 46 tests. Required CI caught a missing import of the new handler tests; connecting the suite to its existing CI entry point produced 1,428 passing tests locally. These overlapping suite counts are not summed as unique coverage.

The isolated PostgreSQL 17 test passes additive membership, idempotency, other-column preservation, anonymous denial, two-account isolation, and refusal/rollback for broadened ownership. Migration `20260910003525` was applied once. Live catalog verification confirms notifications membership, owner-only SELECT RLS, and unchanged unrelated publication entries. Advisor category counts did not change.

## Publication And Browser Acceptance

Club Arena PR [4067](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4067) merged as `3ed5b7d59f407fb0d9cb8d9324c6fdb03b3ff359`. Source CI `34422846423` passed. Publisher [34423638334](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34423638334) passed all four client-test shards, its production build, origin swap, and exact origin verification. This closes the earlier local build freshness failure without publishing that stale local artifact.

At September 10 01:19:38 UTC, both public and origin build-info served the exact merge. The entry actually references `NotificationsPage-t9_zGnVT-v6.js`; its SHA-256 is `83c4a6d267904f27c035ab77d503081aeff573f9be880a3a341778185d2bbd34`. All eight repair markers are present, and released page blob `731a1f53d2eb0e883291c832ea73962f2dd45278` matches the tested source.

World Hub PR [1715](https://github.com/Smarter-Poker/Smarter-Poker-World-Hub/pull/1715) merged as `55e21c8adc1fce02d02fe29eba56b191856606e2`. Required source CI `34424698516` and merge CI `34425061651` passed. Vercel deployment `dpl_Cp65D7Jnfd9Sp2FG7CqCZ27rLRnF` reached READY and owns the production alias. Public `/api/health` served that exact merge at 01:26:27 UTC; both repaired API file blobs match the tested source.

After both releases, controlled Chrome at 01:28:05 UTC showed Notifications, Live Feed, 50 rows, zero error alerts, and the verified entry script. Its browser push permission was blocked. No live read/dismiss, player balance, seat, or registration was altered as an acceptance probe. The page's existing mark-seen behavior still runs on normal navigation.

## Remaining Acceptance

The ten-minute read-only subscription observer reached SUBSCRIBED without errors but saw no events. At 01:21:33 UTC the database confirmed zero notification inserts since restoration. This quiet interval cannot prove end-to-end event delivery. The supported desktop session cannot establish physical iPad/PWA background, reconnect, or delivery behavior.

The loaded engine also fails full-fleet acceptance independently of Phase 12. At 01:23:39 UTC on `b53ad9b2`, 2,000 retained hand-gap samples had p50 2,001 ms, p90 4,585 ms, maximum 17,565 ms; three tables were stalled and blocked settlements were zero. The 01:12:00 to 01:26:47 runtime log window contained no recurrence of the original callback authority fatal. Both callback repair commits are ancestors of this build.

The three stalled tables share tournament `2dcdcee1-524a-423c-89e9-b012c6d3fbd1`. At 01:19:25 the stopped manager's retained move could not resolve: both `fn_move_tournament_player` and `fn_resolve_committed_tournament_seat_move` returned PGRST202. Read-only catalog verification at 01:32:34 UTC confirmed both functions and `tournament_seat_move_receipts` absent. The existing Phase 3 tournament lifecycle audit already records this installed-dependency gap and its protected settlement cutover. No second implementation, live seat repair, gate bypass, or speculative migration was introduced here. A queued engine alone cannot supply these database objects.

Engine run `34423465001` staged an image and completed green, but cutover and version/write-proof steps were skipped because the next break exceeded its budget. It is not engine adoption. The 01:05:33 container replacement was a deploy/recreate event in the supervisor journal; earlier boot-grace churn was also recorded. No restart was forced by this continuation.

The remaining Supabase email findings and exact access limits are recorded in [Supabase follow-through](2026-09-10-supabase-email-follow-through.md). Exact release metadata is in [release JSON](2026-09-10-realtime-phase12-release.json).
