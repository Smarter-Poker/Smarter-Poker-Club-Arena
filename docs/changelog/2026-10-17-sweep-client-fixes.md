# Sweep Client Fixes (2026-10-17)

Dan: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING
ISSUES ANYWHERE AND EVERYWHERE." These are the Club Arena client defects that
sweep confirmed against source and production.

- **Settlement Record was unavailable for every club.**
  `ClubWeeklyAccountingReader` refused any weekly statement whose status was
  not `generated`, but production trigger `trg_weekly_statement_issue_settled`
  (migration 20261015180754) stamps every `club_weekly_accounting` row `paid`
  at issue, so all seven statements on production were refused. Both
  `generated` and `paid` now read as an issued statement; every other status
  and every amount, scope and delivery check still refuses.
- **The Send picker showed 502 of 1,118 friends.** Each friendship direction
  was read with `.limit(500)` and the names with one `.in()` capped at 1,000
  rows. Both directions now page to their end on the unique id and names are
  read in chunks of 200.
- **The Wallet Ledger printed one cent digit** (`+411.8`, `Bal: 1,731.2`).
  It and the cashout receipt checks now use `exactChipFigure`: both cent
  digits or none (launch audit P-24).
- **Stats ignored the menu's club.** `/stats?club=shark-club` opened on All
  Clubs. The menu's `?club=` is now the default, an explicit `statsClub` still
  wins, and All Clubs is remembered as `statsClub=all` while `?club=` is set.
- **The leaderboard opened on Profit while its prizes are paid on Hands
  Played.** A published plan's payout metric is now the default until the
  player picks one.
- **Pages kept the previous page's tab title.** `usePageTitle` names the club
  lobby, Transactions, VIP, Rakeback, Promotions, Bonuses, Players, Club Data,
  Player Stats and the 404 page.
- **Copy.** Trade Record kinds use the statement's words (`Cash-Out`,
  `Tournament Buy-In`) through the shared `src/utils/chipKindWord.ts`;
  Achievements prints "15 Days"; the 404 page no longer prints the path through
  Title Case.
- **Flaky test.** `club-data-page-renders` waits up to 5s for the 200-row page
  that timed out on a loaded runner and failed publish run 38981365558.
