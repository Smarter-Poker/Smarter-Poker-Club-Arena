# Leaderboard Phase 3: Funded Publication

## Scope

Phase 3 Of 6 Adds Union And Standalone Club Funding-Liability Accounting And
Makes Funding A Server-Enforced Publication Requirement. It Does Not Move
Chips, Execute A Payout, Or Change The Settlement Schedule.

## Before The Change

- `fn_publish_leaderboard_reward_program` Validated Prize Shapes, Authority,
  Versions, And Idempotency, But It Never Compared A New Program With The
  Funding Owner's Promo Wallet Or Other Clubs Using That Same Wallet.
- `fn_get_leaderboard_reward_setup` Returned Only The Raw Promo Balance. It Did
  Not Report The Current Program Commitment, Other Club Commitments, Or The
  Amount Still Available For A Replacement Publication.
- `LeaderboardPrizeWizard` Compared Each Period Separately With The Entire
  Wallet. Its Warning Explicitly Said An Unfunded Program Could Still Be Saved,
  And The Continue Button Remained Enabled.
- The Review Screen Still Said Automated Settlement Was Not Available, Even
  Though The Canonical Service-Only Settlement Path Is Now Deployed.

Production Was Read In A Read-Only Transaction Before Editing. One Active
Standalone Program Currently Commits 500.00 Promo Chips Against A 9,607.69
Promo Balance. There Are No Active Union-Funded Programs, No Completed Payout
Batches, And Two Recorded Historical Settlement Failures. No Production Row Or
Balance Was Changed By This Audit.

## Completed Change

1. Derive One Rolling Funding Commitment From Each Funding Owner's Latest
   Published Program, Using Weekly Plus Monthly Prize Totals.
2. Lock The Canonical Promo-Wallet Row During Publication, Exclude The Club's
   Replaced Commitment, Then Reject Any Enabled Program Whose Combined Union Or
   Standalone Club Commitment Exceeds The Wallet.
3. Return Wallet Balance, Total Commitment, This Club's Commitment, Replacement
   Capacity, Uncommitted Balance, Committed Club Count, And Funding Status To
   Authorized Owners. Members Continue To Receive No Wallet Telemetry.
4. Make The Wizard Display Those Values And Block Review Or Publication When
   The Proposed Combined Commitment Is Not Funded.
5. Pin Union-Wide Aggregation, Standalone Isolation, Retry Behavior, Disabled
   Programs, Authorization, And Rollback Safety With Automated Tests And A
   Transaction-Wrapped Production Harness.

The Production Dry Run Compiled The Complete Migration And Exercised Both
Standalone And Shared-Union Wallet Scenarios Inside One Rolled-Back
Transaction. It Confirmed Unfunded Inserts Leave No Program Row, Funded Retries
Remain Exactly Idempotent, Union Commitments Aggregate Across Clubs, Replacement
Capacity Excludes The Current Club's Prior Version, And No Probe Row Escapes The
Rollback.

## Safety Boundary

This Phase Adds A Fail-Closed Publication Gate And Derived Accounting Only.
The Existing Service-Role Settlement Function Remains The Only Automatic Money
Path. No Browser Role Receives A New Table Grant Or Money-Movement Function.
