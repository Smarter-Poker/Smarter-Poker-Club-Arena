# Leaderboard Phase 4: Review Corrections

Follow-Up To `2026-09-20-leaderboard-phase-4-owner-operations-and-rules.md`
(PR #4521, Merged As 15477de6). An Adversarial Review Of That Merged Change
Found Defects The Tests Did Not Catch. This Change Corrects Them. It Is Client
Only: No Database Function, Wallet Balance, Prize Allocation, Program
Versioning, Or Settlement Authority Changes.

## What Was Wrong And What Changed

- Settlement Funding Line. The Merged Line Printed "Seed X And Promo Y Chips"
  With Each Part Floored Separately By The House Compact Format, So The Parts
  Could Contradict The Total Above Them, And A Half-Chip Seed Read "Seed 0".
  The Line Now Names The Pools The Batch Row Recorded ("Seed And Promo Wallet"
  Or "Promo Wallet"); The Only Figure Is The Batch Total. The Seed Is A
  Standalone Club's One-Time Opening Leaderboard Seed; A Union Batch Never Has
  One.
- First Use Versus Settlement. For A Club That Has Never Published A Program,
  The Owner Saw The New First-Use Section And Then A Settlement Card Saying The
  Period "Started Before A Published Prize Program Took Effect" (False: There
  Was Never One) With A Second Setup Button. `setup_complete` Is
  `setup_completed_at IS NOT NULL`, Stamped On Every Save, And Versions Were
  Only Backfilled For Completed Setups, So Such A Club Can Have No Batch Or
  Receipt: The Card Is Now Hidden For It. The "No Program" Copy Is Now True In
  Every Case: "No Published Prize Program Covered This Period When It Started."
- Underfunded Rule. The Rules List Said "Paid From {Wallet} After The Period
  Closes" Even While That Wallet Could Not Cover The Program, Contradicting The
  Safety Line Below It. An Underfunded Program Now Reads "..., Once It Covers
  The Published Prizes."
- Refused Publish Wording. Routing The Wizard's Error Through The House
  Sanitiser Swapped The Server's Funding Refusal For A Generic Line Whenever An
  Amount Had Seven Digits (Exactly The Largest Clubs). Both Deliberate
  Refusals (Funding And Version Conflict) Are Now Restated For The Owner
  Without Figures, With The Next Step; Anything Else Still Goes Through The
  Sanitiser. The Earlier Test Could Not Fail On This Because Vitest Runs With
  DEV On, Which Bypasses The Sanitiser; The New Tests Switch DEV Off.
- Stale Refetch Mark. A Refused Publish Followed By A Successful One In The
  Same Dialog Left The Mark Set, So A Later Cancel Refetched For No Reason, And
  The Mark Survived Club And Account Switches. It Is Now Cleared On Save And On
  Every Fetch Of The Owner Record.
- Hamburger Search. Substring Matching Against The Vocabulary Let Fragments
  Such As "a" Or "ward" Reveal The Owner Prize Tools. Each Typed Word Must Now
  Start A Vocabulary Word, So Type-Ahead Still Works. The Rule Lives In
  `src/components/navigation/rewardToolSearch.ts` With Its Own Tests.
- Markup. The Rules List Keeps List Semantics In WebKit (`role="list"`), And
  The Published Time And Effective Dates Sit Inside Their `<dd>` Instead Of As
  Invalid Direct Children Of The Definition List's Group.

## Verification

- Focused Vitest, Four Copy Gates, `tsc --noEmit`, ESLint And Prettier On The
  Exact Candidate In The Private Worktree; Renders Of The Affected States.
- Live Proof For The Merged Console (Recorded 2026-09-21): Publish Run
  35524133606 Served 15477de6; Post-Deploy Client Runs 35524451338 And
  35631091479 Passed Both Signed-In `leaderboard-console` Tests. The Client Job
  Itself Reports Failure Because Of The Unrelated
  `production-daily-missions.spec.ts:291`, Which Also Failed Before PR #4521.
