# Leaderboard Painted Console

The User Explicitly Approved Replacing The Protected Championship Deck Design
With The Approved #ClubArenaConsole Master. This Change Is Limited To The
Leaderboard Surfaces And Their Tests. It Does Not Change Database Functions,
Wallet Balances, Prize Allocation, Program Versioning, Or Settlement Authority.

## Changes

- Rankings And Tournament Stats Share One Painted Spade Console. Prize Program
  And Settlement Details Print On Its Glass Without A Nested Frame.
- The Owner Wizard, Table Leaderboard, And Standalone Promotion Board Use The
  Approved Flat-Top Console. Embedded Promotion Boards Remain Unframed.
- Generic Glyphs, Artificial Podiums, Invented VIP Rings, Gradients, And CSS
  Panel Frames Are Removed. Long Player Names Wrap; Tournament Fields Carry
  Their Own Labels On Mobile. Controls Have At Least 44-Pixel Touch Heights.
- The Setup Button No Longer Overlaps Its Safety Copy. Rankings Precede The
  Detailed Prize Program. The All-Recorded Tournament View No Longer Offers
  Period Controls Or Prize Details That Do Not Filter Its Results.
- Display Amounts Use The Shared Compact-Chip Convention. Editable Prize
  Inputs And Submitted Amounts Retain Exact Cent Precision; CSV Data Is Unchanged.
- The Promotion Board Rejects Stale Responses, Clears Previous Pinned Ranks,
  Distinguishes Failure From An Empty Board, And Provides A Working Retry.
- Its Service Propagates Database Read Failures To That Retry UI. Boundary
  Tests Verify Failure, Successful Empty Results, And Exact Stored Amounts.
- Table Leaderboards Now Expose Dialog Semantics, Escape, Focus Containment,
  Selected Period State, And Scroll Restoration.

## Verification

- 181 Focused Tests Passed Across 22 Files, Including Existing Funding,
  Settlement, Versioning, Authorization, Copy, And Interface Contracts.
- 99 Synthetic Browser Layout/State Checks Passed At 320, 393, And 1440 Pixels.
  Covered Rankings, Tournament Scrolling, All Wizard Steps, Insufficient Funds,
  Save Failure, All Settlement States, Embedded Boards, Loading, Empty, And Error.
  Owner Setup Navigation, Scope Changes, Exact-Cent Input, And Escape Were Exercised.
- All Four Copy Gates Passed. No Em Dashes Were Found In UI Text.
- New Read-Only Production Tests Are In The Existing Post-Deploy `routes/`
  Suite. They Require A Rendered Console, Functional Filters, Correct Tournament
  Controls, And Mobile/Desktop Fit, Not Just A Nonempty Page.
- Local Type Checking Reports Missing Native Dependencies In The Existing Mac
  Dependency Tree. The Required Clean CI Typecheck And Build Remain Release Gates.

Synthetic Fixtures Are Not Production Or Money-Movement Evidence. Release
Completion Requires The Owning Publisher, Served Build Provenance, And The
Post-Deploy Results. Temporary Render Fixtures Are Not Shipped.
