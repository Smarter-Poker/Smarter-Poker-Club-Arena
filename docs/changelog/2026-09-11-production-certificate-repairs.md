# Production certificate repairs

The exact-release browser run 34636213509 failed on MTT connection acknowledgment, a cash-table View click intercepted by fixed mobile controls, unsettled jackpot page height, and a Daily Bonus error that discarded its original cause. Fixture cleanup and exact-release checks passed. This patch is being qualified against those failures; the failed run is not a successful certificate.

## Connection and identity

Both engine WebSocket entry paths now request one service-only database verdict for arena validity, current seat, scoped membership, observer restriction, active ban and the IP restriction setting. The previous four parallel gates still repeated table/seat/scope reads through several database phases, cached moderation decisions, and allowed some failed checks. The new function uses one stable snapshot and existing indexed predicates. Invalid, mismatched or failed replies refuse access. Current ban/setting changes take effect on the next connection. A banned viewer cannot trigger an empty-table wake.

The same-address check uses live connections after the durable verdict. It now includes settled multiplexed subscriptions, which the previous tableId-only check missed, while preserving reconnects by the same account and avoiding false matches on unknown proxy addresses. Duplicate pending SUBSCRIBE frames share the existing request; retired requests cannot authorize replacements. The connection banner's timing and acknowledgment requirements are unchanged.

The public WebSocket metrics expose only aggregate authority counts and monotonic durations, including pending age and failures, so another absent acknowledgment can be distinguished from a completed refusal without logging identities or payloads. Hole-card recovery waits for the authenticated identity instead of sending the initial guest value as a UUID.

## Daily Bonus

The status service retains the RPC/transport cause, HTTP status, and a safe payload-shape label in a typed failure. The active entry or sheet request owner reports it once; retired requests do not report or retry. Players continue to see the existing friendly error. A successful HTTP response with a null/array/scalar body remains a separate contract failure. No console-error whitelist or retry delay was widened.

The authenticated production smoke suite now verifies a successful JSON object from the actual status response and attaches only HTTP status, content type and body shape. It uses the certificate's existing isolated account. Signed-out smoke runs skip this account-specific probe.

## Qualification boundary

Initial local verification passed 9,812 server tests with 145 existing opt-in skips, 106 relevant client/source tests, both typechecks, and 97 focused connection tests. The guest-identity test failed on the preceding source and passed after the guard. A further banned-table-wake case was added during final review. Native database and mobile browser proof accompany the final patch; local results do not claim deployment or production certification.

Apply the exact additive connection-verdict migration and verify its service-only permissions before starting an engine built from this source. The complete release still requires protected CI, immutable deployment identity, an exact-release production certificate, and successful fixture cleanup. All engine and accounting source remains in Smarter-Poker-Club-Arena; this repair writes no World Hub files and applies no D9 accounting work.
