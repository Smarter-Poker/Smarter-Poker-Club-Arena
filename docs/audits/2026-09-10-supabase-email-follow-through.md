# Supabase Email Follow-Through

This follows the September 9 reconciliation with current evidence. It does not reopen the separate accounting, Diamond, or estate audit programmes.

## Confirmed Repairs And Current Measurements

- Notification updates were missing because migration `20260908031934` used `ALTER PUBLICATION supabase_realtime SET TABLE`, replacing all previous members. Phase 12 restores only `public.notifications` through migration `20260910003525`. Owner-only SELECT RLS, replica identity FULL, and every unrelated publication column list were verified unchanged. All isolated PostgreSQL migration assertions passed, including refusal of broadened ownership. Both advisor snapshots retained exactly the same category counts.
- The live reminder compatibility function delegates to `prepare_tournament_reminders(300)`. Its former player-row writer is retired; its once-per-minute cron remains a secondary backstop to the published durable worker. At September 10 01:21:33 UTC, all 327 recorded compatibility runs since the September 9 19:54:46 repair succeeded. Function body MD5s: compatibility `0383aa3b8f75dd7d4f05cdc21b55272e`; prepare `fa71cfcb31f0bdd4650a927f56633307`.
- At 00:39:26 UTC, 139 cron jobs were active, 11 every minute. The preceding 24 hours contained 24,067 successes, 64 failures, and one running invocation. These totals include pre-repair failures and are not attributed to Phase 12.
- The narrower September 9 08:00 to September 10 00:43 window had four failures: three reminder deadlocks before its repair and one hand-history vacuum statement timeout at 17:32. The latest four vacuum runs subsequently succeeded in 6 to 9 seconds. The recent materialized-view refreshes also succeeded. No speculative index or DDL was applied to those jobs.
- The solver table is actively read: index scans increased from 63,574 to 63,729 and fetched tuples from 629,029 to 630,336 between 00:51:57.098411 and 00:55:59.803475 UTC. Its total size was 85,554,315,264 bytes. This does not support treating the entire table as unused cold storage. No full-table scan was performed for this measurement.
- Four idle-in-transaction connections seen in one sample did not establish long-held transactions; follow-up activity snapshots showed subsecond transactions. No connection was terminated.

## Evidence Still Missing

The cumulative database deadlock counter rose from 73 at 00:43 to 74 by 00:51:57 and remained 74 at 01:21:33. No new cron failure identified that occurrence. World Hub production runtime logs contained no matching deadlock rows for 00:39 to 01:00; that narrower application result cannot clear PostgreSQL itself.

The connected Supabase surface exposes no detailed logs or service-egress query. No Supabase Management API token was present in the known project credential sources. The normal log reader stopped before making a request. This is not a freshly observed HTTP 403 and is not evidence that the historical errors disappeared. PostgreSQL log access and the per-service egress breakdown are still needed to identify the remaining SQL caller and explain the email's historical traffic total.

Broadcast remains an option to evaluate against measured consumers and delivery needs, not a reason to replace every active channel blindly. Phase 12's demonstrated missing membership was repaired without restoring unrelated high-volume tables or adding a cron.

No physical iPad/PWA delivery or background-resume session was available. The ten-minute read-only notification observer subscribed without error, but saw no events; the database confirmed zero inserts since restoration as of 01:21:33. This establishes a quiet observation window, not end-to-end delivery acceptance.
