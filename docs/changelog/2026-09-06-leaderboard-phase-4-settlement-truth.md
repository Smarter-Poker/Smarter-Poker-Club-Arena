# Leaderboard Phase 4: Settlement Truth

2026-09-06. The Leaderboard UI Could Show Planned Prizes And Past Payout Rows,
But It Could Not Tell A Player Whether A Closed Round Was Waiting, Delayed, Or
Paid. The Settlement Routine Also Fell Through From Promo Funds To Operating
Club Or Union Funds, Which Contradicted The Product Contract.

## Shipped

- Settlement Is Promo-Only. An Affiliated Club Uses Its Union Promo Wallet; A
  Standalone Club Uses Its Opening Promo Reserve And Club Promo Wallet. An
  Underfunded Round Stays Unpaid, Records A Safe Failure, And Retries Through
  The Service Scheduler.
- Tied Players Split The Combined Prizes For Their Occupied Places. Allocation
  Uses Exact Cents With Deterministic Residue, So A UUID Never Breaks A
  Sporting Tie And The Batch Total Is Conserved.
- Every Winner Receipt Links To Its Immutable Payout Batch. Failed Attempts
  Retain Their First Failure, Latest Failure, Attempt Count, Error Category,
  And Resolution Instead Of Being Deleted.
- One Authenticated, Read-Only Settlement RPC Returns The Published Program,
  Canonical Period State, Batch, Receipts, And Owner-Safe Recovery Guidance.
  Browser Roles Still Cannot Execute Either Money-Moving Function.
- The Leaderboard Settlement Desk Shows Open, Pending, Delayed, Paid, Disabled,
  And Unpublished States In The Club Arena Theme. Players See Their Exact
  Receipt; Funding Owners Get A Prize-Setup Recovery Route, Never A Browser
  Payout Button.
- Planned Prize Badges Use The Same Tie Allocation Rule As Settlement.

## Verification Contract

The Production-Safe Harness Verifies The Promo-Only Function Body, Immutable
Receipt Link, Browser Grant Boundary, And An Authenticated Current-Period Read.
It Does Not Invoke Settlement Or Move Chips.

## Migration

- `20260906084547_leaderboard_phase_4_promo_only_settlement_truth`

The Migration Is Recorded In `schema-manifest.d`. The Shared Historical
Migration Changelog Remains Untouched.
