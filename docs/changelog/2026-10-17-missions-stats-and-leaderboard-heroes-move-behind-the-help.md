# Missions, Stats And Leaderboard Heroes Move Behind The Help

Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL DESCRIPTIONS
THAT EXIST LIKE THIS ON ANY AND ALL PAGES. ADD A ? MARK ICON INSTEAD IN THE
UPPER RIGHT CORNER". This is the batch that covers Daily Challenges, Player
Stats, Player Statistics and the Leaderboard.

## Daily Challenges (#SmarterCasinoRealism)

- The hero lost its eyebrow ("Club Arena / Daily Challenge Vault" and the
  weekly and monthly lines), its giant title, its description and its vault
  scene art. The title is now the PageBar's hidden h1 (`#missions-title`), and
  the description is the help's first step.
- **The bevel frame stays.** The live meters (cycle clock, spendable balance),
  the `role="status" aria-live` cleared seal and the two doors (View Challenge
  Ledger, which keeps its scroll and focus, and Back To Arena) sit on it. The
  vault photo was decoration beside the copy: on a phone it was a 244px band
  above the text, not a frame the meters printed on. It is gone, and so are
  its shade, the cycle atmosphere and the decorative cycle instrument.
- Loading, cold-error and route-shell states print only their state: a hidden
  h1, then the loading signal or the alert with its retry.
- Section kickers removed: "Challenge Ledger", "Daily Streak Circuit" (and its
  "Keep The Circuit Alive" line), "Daily Cycle Utility / Optional Challenge
  Alerts", "Casino Floor Concierge". The footer keeps only Browse Cash Games;
  its sentence and the reset times are tutorial steps now. The alert panel's
  push-consent paragraph stays.
- `public/images/challenges/daily-missions-casino-v2(-mobile).webp` stay in the
  append-only pool, and nothing in `src` references them.

## Player Stats

- The deck lost the "Club Arena // Player Analytics" eyebrow, "Player
  Intelligence" (now the hidden h1 `#stats-page-title`), the paragraph and the
  dossier art. The analysis window, the gauge and every figure stay on the
  chamfered frame.
- `useArenaStatsScope()` no longer returns an eyebrow. The arena scope prints
  as PageBar status "Figures In Diamonds", the only place that unit is stated.
- The loading and privacy-gate heroes print their state only. The shared-club
  view prints a PageBar, and its two section kickers are gone.

## Player Statistics

- The hero (eyebrow "Measured From Verified Hands", title "Player
  Performance", paragraph, felt art, location line) is a PageBar holding the
  Go Back door. Its three readouts repeated the Volume and Club Result cards,
  so they went too.

## Leaderboard

- The console keeps its title and live scope subtitle; the "Club Arena"
  eyebrow is gone and a `PageBar titleAs={false}` sits above it. The prize
  program kickers label sections inside the console, so they stay.
