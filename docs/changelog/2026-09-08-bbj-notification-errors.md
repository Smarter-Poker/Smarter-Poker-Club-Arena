# BBJ Notification Failures Reach The Error Reporter

The notification insert returned database errors to a console-only branch, while thrown requests reached reportError. Parked-share read failures also used only the console at their source. Both failures now reach the existing error reporter with the appropriate BBJ operation context.

The payment result remains paid after a notification failure. The error stays inside the post-payment notification boundary, so it cannot retry an already committed jackpot. No new queue, backpay job, wallet write or notification was executed by this audit.

Verification: two new actual-module regressions failed before the correction. Afterward, 95 tests passed across the payout and real queue-writer suites, including returned-error and rejected-request notification failures, a failed parked-share read, and exactly one payment RPC. Server TypeScript passed. The changed production files contain no TODO, FIXME or not-implemented stubs.

This closes reporting inconsistencies only. Notifications remain best-effort, and replay delivery, database concurrency, the blocked F30 source mirror and the unfinished satellite candidate remain separate open work. Engine deployment must be verified separately from source merge.
