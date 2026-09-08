# HTTP Authentication Cannot Hold An Action Forever

## Root Cause And Change

HTTP actions awaited getAuthHeaders before starting their fetch. That helper
could wait indefinitely on an auth module, getFreshAccessToken/getSession, or
its fallback refreshSession. engineFetch also awaited an unbounded refresh
following a 401. Socket reconnect deadlines did not cover either HTTP wait.

Each auth wait now has a 15-second deadline. Expired initial authentication
returns through the caller's existing failure path without sending the action.
An expired 401 refresh returns the original refusal without retrying. A late
token read cannot start a fallback refresh or send the old action; late refresh
completion cannot replay it. Timers clear on success and failure. The shared
SDK request is not aborted, and its internal side effects are not claimed fixed.

This applies through the shared HTTP helper to every game format. Existing
401 login-ownership guards, idempotency bodies, and ambiguous-failure behavior
remain unchanged. The initial-token account-switch race and sessionRevoked's
internal SDK sign-out/refresh ownership are still separate audit items.

## Verification

Five new fake-network cases cover late token/null responses after timeout,
a never-answering fallback refresh, a late 401 refresh success, and cleanup
when normal auth succeeds. The focused HTTP suites passed 23 tests. Client
TypeScript and the production build are required before push. No live action,
account sign-out, or paid feature is used for the tests.

## Industry Comparison Reviewed September 8, 2026

There is no single universal reconnect duration in the operators reviewed.
[PokerStars cash-game help](https://www.pokerstars.com/help/articles/ring-time-ma/)
separates the thinking-time bank from disconnect protection and describes
pot-dependent reconnect time, roughly 30 to 240 seconds.
[Its tournament rules](https://www.pokerstars.com/poker/tournaments/rules/)
vary eligibility and successive allowances by tournament format and describe
pausing blind progression during disconnect extra time.
[GGPoker's house rules](https://legal.ggpoker.com/house-rules/) describe extra
reconnection time in late tournament stages, checking when possible and folding
when facing action after timeout. Those are operator policies, not proof of
an implementation or a universal technical standard.

Dan's explicit policy remains the authority here: identical protection for
cash, MTT, Spin, SNG, and heads-up; 30 seconds normally and 45 for eligible VIPs.
Expired cards do not qualify; active cards with explicit no-expiry do. This
comparison does not change those numbers or assert that Club Arena is superior
to every operator. Physical mobile/offline and all-format seated-user testing
remain outstanding, as does a separate audit of tournament blind-clock behavior
while an individual player is using disconnect protection.
