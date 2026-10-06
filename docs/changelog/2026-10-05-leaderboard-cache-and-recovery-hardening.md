# Leaderboard Cache And Recovery Hardening

- Removed the five-second membership UI timeout that could preempt the service's longer bounded retry sequence and leave an older membership request running behind a manual retry.
- Added request-generation checks so stale membership and rank responses cannot overwrite a newer club scope or component state.
- Scoped private club-board cache keys by account while keeping the public global board shared.
- Made personal-position retry rank-only and single-flight, preventing repeated taps from launching overlapping full-board refreshes.
- Required the deployed-page performance probe to observe a real, finite, positive LCP value instead of treating a missing observer result as a pass.
- Added regression coverage for delayed membership recovery, account cache isolation, and repeated position retry.

Verification: Focused leaderboard tests, typecheck, ESLint, policy consistency, and production build pass on the release candidate. Exact hosted publication and deployed-page verification remain release gates.
