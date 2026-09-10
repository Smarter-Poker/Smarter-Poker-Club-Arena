# Tournament Reminder Release Verification

Server execution is published and verified. Physical notification acceptance remains incomplete.

The generator now commits versioned receipts with the outbox without updating player rows or taking gameplay foreign-key locks. The continuous worker restores due work from committed records on startup and retry. The shared sender revalidates eligibility and consent, limits TTL to the reminder deadline, and preserves uncertain delivery outcomes. Existing compatibility callers remain secondary. No new cron, credential, provider or infrastructure was introduced.

## Reproduced Failures And Tests

The legacy player-row lock timeout was reproduced before the database repair. The database suite now passes 43 isolated PostgreSQL 17 checks, including rollback, concurrent consumers, abandoned claims and denial of browser execution for the authorization RPC.

Live worker-origin readiness exposed a second defect at 21:26:46 UTC: the worker's local cron credential received HTTP 401 from World Hub. Three actual-endpoint regressions and two actual-transport regressions failed before correction. The endpoint now verifies the caller's existing database service authority with an empty, read-only service-role RPC and uses that same client for dispatch. No grants or credential values changed. All 24 sender tests and 11 worker tests pass, along with the required builds and CI gates.

The initial healthy startup samples are not delivery acceptance evidence. They did not expose the authentication defect; the worker-origin readiness check did.

## Verified Releases

| Owner                      | Repair                       | Running Or Published Revision              | Required Evidence                                                                                          |
| -------------------------- | ---------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Club Arena database record | PR #4012                     | `6e9de72fec52c481ab515814600aa2a29b4ce297` | CI `34406576673` passed; public and origin served descendant `65931a248c4f35b15e6dbd50aedd3b2f8d08a576`    |
| World Hub sender           | PR #1695, corrected by #1700 | `04c10d4f30c1b7e8291f99ca04c0e18bfcd52689` | Public health matched; all corrected source blobs matched; required gates passed                           |
| Continuous worker          | PR #127, corrected by #128   | `d91ac884be10741aed2c96029e52ffa3129f51ff` | CI `34409445299` passed; deployment `34409607658` completed build, cutover and exact-revision verification |

At 21:52:37 UTC on September 9, the actual worker successfully reached the corrected sender's read-only readiness endpoint: HTTP 200, protocol 1, `reminderAuth: database_service_role`. The corrected caller was then published through the normal workflow. No manual merge, hook bypass, forced restart or live player probe was used.

## Natural Production Cycle

The post-correction observation contains 13 samples from 2026-09-09T21:57:54.465862+00:00 through 2026-09-09T22:04:00.009808+00:00. Every sample served the expected worker revision. No consecutive failures, failed attempts or uncertain results were observed. Scoped worker error logs contained zero reminder errors through 2026-09-09T22:03:46.406518+00:00.

At 21:58 UTC, the worker generated 19 queued reminders and the receipt generator suppressed five seated players. Its authenticated dispatch call completed at 21:58:01.156 UTC. All 19 queued rows were explicitly skipped for `no_subscription`, and no pending or processing reminder rows remained. The 19 rows formed one claim batch; creation-to-claim delay was 253.028 ms for every row. This is one batch observation, not a fleet-wide latency claim.

The worker's own dispatch counters recorded zero sent/skipped rows while the shared outbox consumers completed those rows. No provider delivery is attributed to that worker call. The overlap is covered by the shared sender and claim-ownership tests.

## Remaining Acceptance

No physical iPad/PWA session with notifications enabled was available to verify notification display, tap-through and return to the table. These natural rows had no active subscription, so they provide no provider/device receipt evidence. Server results cannot replace that acceptance. The whole realtime programme is not declared 100% complete.

Exact evidence: [release JSON](2026-09-09-tournament-reminder-release.json).

- https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4012
- https://github.com/Smarter-Poker/Smarter-Poker-World-Hub/pull/1700
- https://github.com/Smarter-Poker/smarter-poker-workers/pull/128
- https://github.com/Smarter-Poker/smarter-poker-workers/actions/runs/34409607658
