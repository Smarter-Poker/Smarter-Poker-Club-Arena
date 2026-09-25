# Leaderboard Phase 4: Union Templates, Program History, Round Countdown

Closes The Remaining Phase 4 Owner-Operations Items From The Original
Leaderboard Audit (2026-08-30): "Union-Wide Templates: Configure Once, Apply To
Selected Clubs, And Allow Controlled Per-Club Overrides", "Configuration History
Showing Who Changed What And When", And "Period-Close Countdowns". Adds The
Phase 4G Accessibility, Error And Performance Evidence To The Post-Deploy Route
Spec. Client Only: No Database Function, Grant, Wallet Balance, Prize
Allocation, Versioning Or Settlement Authority Changes.

## Union Templates

- In The Setup's Review Step, The Owner Of A Union-Funded Club Can Also Publish
  The Same Plan To Other Clubs Of That Union Whose Prizes They Manage (From
  `fn_leaderboard_reward_contexts`). A Standalone Club Has None.
- Each Club Receives The Plan As Its Own Next Version Through The Existing
  `fn_save_leaderboard_reward_setup`. Its Current Record Is Read First: The
  Expected Version Is That Club's Own, The Owner Must Still Manage It, And It
  Must Still Be Funded By The Same Union (A Club That Left Would Otherwise Get A
  Plan Funded From Its Own Wallet). The Server Stays The Authority On Funding,
  Version And Permission.
- Clubs Are Published One At A Time, So Each Is Checked Against The Union
  Wallet Capacity The Previous Ones Left. A Refused Club Is Listed With The
  Reason; "Retry Refused" Re-Reads And Retries Only Those Clubs. Nothing Is
  Rolled Back: Every Published Club Keeps Its New Version. Each Club Can Still
  Be Edited On Its Own Afterwards (The Per-Club Override).

## Program History

- Prize Managers See The Newest Published Versions (Three, Expandable To Six)
  With The Published Time In UTC, The Publisher, What Changed Against The
  Version It Superseded (Prizes Enabled Or Disabled, Ranking Signal, Split,
  Weekly And Monthly Totals, Rearranged Places Or An Unchanged Republish), And
  The Weekly And Monthly Effective Dates.
- Read From `leaderboard_reward_program_versions`; Publisher Names From
  `profiles`. Malformed Or Foreign Rows Fail The Read Instead Of Painting An
  Unverified History; A Failed Name Lookup Keeps The History ("Publisher
  Unavailable").
- Disclosed, Not Changed Here: The Installed RLS Policy ("Leaderboard Reward
  Programs Are Public After Publication") Lets Any Signed-In User Read Every
  Club's Published Versions, Including `published_by`. The Page Shows History
  Only To Prize Managers, But Restricting The Rows Themselves Needs A Migration
  (A SECURITY DEFINER Owner Check Used By A New SELECT Policy).

## Round Countdown

- An Open Weekly Or Monthly Round Shows "Closes In 5D 4H" (Hours And Minutes
  Near The End) From The Server's Exclusive UTC Period End, So The Countdown
  And The Settlement Run Agree On The Instant. It Ticks Every 30 Seconds.

## Accessibility

- Two Labelled Divs Gain `role="group"` (axe `aria-prohibited-attr`). The
  History Error's Live Region Announces The Message Only.
- Local axe Runs Over 23 Rendered States (Page, Setup Steps, Template Results,
  History, Settlement) Found No Violations; `color-contrast` Is Undecidable Over
  The Painted Art, And The New Text Measured From Pixels Is At Least 6.97:1.

## Post-Deploy Route Spec

`tests/e2e/routes/leaderboard-console.spec.ts` Now Also Checks, At 393 And 1440:

- No Serious Or Critical axe Findings On The Console In Three States (Global
  Hands Played, My Clubs Tournament Stats, My Clubs Rankings).
- No Uncaught Exception, No Application Console Error (The One Subresource
  Exclusion From `admin.spec.ts`), And No Club Arena File That Failed To Load.
- The Route Chunk And The Three Default Console Slices Were Actually Fetched.
- One `LEADERBOARD_PERF` Line Per Width In The Job Log: Time To The Console And
  To The First Ready Board, DOMContentLoaded, Load, LCP, CLS, Resource Count And
  Bytes, The Leaderboard Chunks And Console Art (Bytes, Duration), And Data Read
  Durations. Names And Paths Only, Never Query Strings Or Message Text.
- Full-Page Pictures Go To The Test Output Directory, Which The Workflow
  Uploads When A Job Fails Or Is Cancelled.

## Baseline Recorded Before This Change (Production 0caf2546, 2026-09-22)

- Leaderboard-Only JS And CSS: 41,883 B Brotli (132,898 Raw); Route Cost Beyond
  First Paint: 69,781 B Brotli Across 17 Files. First-Paint Bundle 318,898 B.
- Default Console Art (Top, Mid, Bottom Foot): 172,610 B; The Owner Setup Adds
  225,534 B. The Leaderboard Has No Per-Chunk Budget Today.
