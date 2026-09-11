# Confirm Rakeback Claim Responses

The rakeback page previously ignored the claim response's success/error fields and could announce a claim using invalid or contradictory totals. The candidate preserves installed RPC keys and requires explicit success with finite nonnegative amounts and valid period counts. Refusals show the server error; zero totals report no payout; partial claims show only the confirmed amount; unconfirmed replies trigger authoritative refresh without announcing a claim.

A new attempt cancels the previous success timer so it cannot reset a pending claim.

Current WALLET_REFRESHED subscribers refetch or invalidate caches, so its existing payload contract is unchanged. Twenty-five focused component cases passed. The original eight-case UI proof is preserved separately under `docs/audits/2026-09-11-rakeback-claim-response/baseline-9da95b3`.

This is a dormant integration candidate. UI publication still depends on the reviewed standalone legacy maturity, pointer and duplicate-payment repair; no database or capability activation occurs here.
