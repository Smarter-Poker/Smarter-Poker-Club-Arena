# Leaderboard Phase 4: Owner Operations, Rules, And Console Delivery

Continuation Of The Leaderboard Programme. This Change Carries The Approved
Painted Console (See `2026-09-13-leaderboard-painted-console.md`) Forward Onto
Current Main And Closes The Phase 4 Owner-Operations And Player-Rules Gaps
Found By The 2026-09-20 Audit. It Is Client Only: No Database Function, Wallet
Balance, Prize Allocation, Program Versioning, Or Settlement Authority Changes.

## What Was Missing And What Changed

- First Eligible Use. An Owner Whose Club Has Never Published A Program Now
  Sees A "No Prize Program Yet" Section On The Club Board With The Funding
  Wallet Named And A Set Up Prizes Action. Members Never See It. Before, The
  Only Cue Was The Button Label In The Control Deck.
- Player-Facing Rules. The Published Program Section Now States The Ranking
  Signal, The Sunday/First-Of-Month 00:00 UTC Boundaries, Next-Period
  Activation, The Tie Rule, The Funding Wallet, And What Prize Versus Paid
  Means. The Old Copy Promised "Planned Prizes Are Hidden Until ... Covers
  Every Published Commitment", Which The Page Never Did; It Is Removed.
- History. The Program Version Now Carries Its Published Moment In UTC.
  Program Hash, Publisher Identity, And A Version List Are Not Rendered:
  Publisher Identity Is Not In The Read Contract And A Version List Needs A
  New RPC, So Both Are Disclosed As Remaining Rather Than Faked.
- Settlement Truth. The Funding Line Prints What The Batch Row Recorded
  (Seed And Promo Amounts, Or Promo Wallet), Not A Fixed "Promo Only". The
  Tie Rule Appears On Pending, Delayed, And Paid Rounds, Not Only Live Ones.
- Refused Publish Recovery. When A Publish Is Refused (Version Conflict,
  Funding Refusal, Lost Response) The Wizard Reports It Through The House
  Error Sanitiser And The Page Refetches The Owner Record On Close, So The Next
  Attempt Starts From The Current Version Instead Of Repeating The Conflict.
- Copy And Reach. The Member-Visible Kicker Is "Prize Program" (Was "Owner
  Prize Circuit"). Custom Amount Inputs Carry A Title Case Accessible Name.
  The Hamburger Search Matches Any Word An Owner Would Type, In Any Order.
- Console. The Wizard Backdrop Is Solid Black: The Console Interior Is Glass
  And The Rankings Were Faintly Readable Through The Dialog Body. The Step
  Heading No Longer Draws A Focus Ring When It Takes Programmatic Focus.

## Templates And History, Honestly

Suggested Splits (Balanced, Top Heavy, Even, Custom) Are Presets Applied To
Both Periods At Once; They Are Not A Saved Template Library And Are Not
Described As One. Immutable Program Versions Exist In The Database; The UI
Shows The Current Version, Its Effective Dates, And Its Published Time.

## Verification

- Focused Vitest, Four Copy Gates, `tsc --noEmit`, ESLint, And Prettier Ran
  On The Exact Candidate In A Private Worktree With Locked Dependencies.
- Rendered With Real Fonts And Global CSS At 393px (Plus 320px And 1440px For
  The Main Board): Rankings (Owner, Member, Loading, Empty, Error, Global),
  Tournament Stats, First Use, Funded, Underfunded, Disabled, All Six
  Settlement States, Every Wizard Step Plus Underfunded And Save Error, Table
  Panel, And Promotion Card. Missing Assets: None. No Horizontal Overflow.
  Evidence: `/Volumes/SmarterArchives/agent-evidence/2026-09-20-leaderboard-phase4/`.
- Synthetic Fixtures Are Not Production Or Money-Movement Evidence. Release
  Completion Requires The Owning Publisher, Served Build Provenance, And The
  Post-Deploy Client Browser Verification.
