# Players Explicitly Request A Bounded Deal Review

A proposal binds the last committed hand. Collecting consent while hands continue can invalidate every vote before the engine parks. The client now supports the coordinated server lifecycle that pauses at a safe hand boundary before exposing the stable proposal.

Opening the card reads review state only. A remaining player explicitly requests review. The screen shows the pending boundary, then displays exact shares only when the server confirms reviewing. It displays the server deadline without extending it or using a local timer to authorize expiry or release.

Review identity, deadline, proposal identity, and revision must agree across the metadata and proposal reads. Requests, votes, and cancellations are separate, single-flight actions. Lost responses cause readback only. Cancellation carries the displayed review ID. An already completed review is reported as closed, without claiming cancellation won or that a payment occurred.

Cancelled or expired reviews show their authoritative state and require an explicit new request. No proposal or vote is reused automatically. Account and tournament context fencing from the preceding fix applies to all three actions.

## Verification

- 106 focused tests passed in three files: 50 service contracts, 19 rendered scenarios, and 37 detail contracts.
- Rendered coverage includes no pause on opening, duplicate request clicks, pending boundary, lost request response, requested-to-reviewing-to-expired polling, exact cancellation identity, and completion racing cancellation.
- Strict full client source TypeScript passed. Existing root dependencies were used without copying or installing packages.
- Logs: /tmp/codex-chip-ui-review-lifecycle-tests.log and /tmp/codex-chip-ui-review-lifecycle-tsc.log.
- No production operations, publication, database migration, or guard activation occurred in this lane.

## Coordinated Release Gate

The matching review lifecycle SQL and engine must be integrated and verified with this client. The SQL owns the configured deadline and engine transitions. This source does not prove native pause/release or consent-to-payment completion. CA-03-06, CA-03-12, and overall Phase 3 remain open until their remaining native and publication/browser gates pass.
