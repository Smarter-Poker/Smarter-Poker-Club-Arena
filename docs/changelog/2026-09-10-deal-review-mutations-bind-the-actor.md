# Deal Review Mutations Bind The Displayed Actor

A successful client authentication check does not bind a later request's token. Switching accounts during token acquisition could record the new participant's action before the client rejected its returned actor identity.

The client now sends mandatory `p_expected_actor_id` for review requests, review cancellation, and proposal votes. It comes from the displayed card/review/proposal actor. The matching SQL compares it with `auth.uid()` before locks or writes; the supplied value is a precondition, never an authority. The client retains its authentication preflight and response identity checks, and displays a clear account-change refusal.

Three forced token-switch regressions failed before the input was added: the synthetic RPC boundary recorded the other participant for request, cancellation, and vote before the client rejected the response. All three pass after the correction with no recorded side effect. This client fixture proves transmitted identity and handling; the payout lane owns real PostgreSQL before-write and permission evidence.

The full focused client batch passes 109 tests across three files; full client strict TypeScript passes. Logs: `/tmp/codex-chip-ui-review-actor-before.log`, `/tmp/codex-chip-ui-review-actor-tests.log`, and `/tmp/codex-chip-ui-review-actor-tsc.log`.

This requires the matching mandatory-actor SQL signatures. No fallback to an unbound mutation overload is added. No production mutation, publication, or activation occurred; the accounting programme and its native deployment gates remain open.
