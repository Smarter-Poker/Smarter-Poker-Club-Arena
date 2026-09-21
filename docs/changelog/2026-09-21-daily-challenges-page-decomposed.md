# Daily Challenges Page Decomposed Without Behavior Change

Phase 3 of the Daily Challenges programme. `src/pages/DailyChallengesPage.tsx`
was about 2,600 lines and its stylesheet about 4,200 lines. Both are now
decomposed by product responsibility, and nothing a player can see or do
changed: the DOM, ids, roles, aria attributes, class names, handler order,
focus management, timers, guards and telemetry calls are the same, and the
built stylesheet chunk is rule-for-rule identical under one module hash.

## Units

Under `src/components/challenges/dashboard/`:

- presentation: `missionPresentation.ts` (tier tables, artwork paths,
  formatters, `TieredChallenge`), `MissionArtwork.tsx` (hero picture,
  diamond mark, freeze vault graphic), `MissionClockLeaves.tsx` (cycle
  countdown, reset readout)
- surfaces: `MissionHero.tsx`, `MissionSyncNotice.tsx`,
  `MissionStreakConsole.tsx`, `MissionSummaryGrid.tsx`,
  `MissionRewardVault.tsx`, `MissionCycleRail.tsx`, `MissionLedgerList.tsx`,
  `MissionCard.tsx` (the mission card with its progress track and inline
  reroll confirmation), `MissionFooter.tsx`, `MissionAlertsPanel.tsx`
- states: `MissionLoadingState.tsx`, `MissionUnavailableState.tsx`
- dialogs: `MissionFreezePurchaseDialog.tsx`,
  `MissionRewardSettlementDialog.tsx` (the page keeps both portals and
  focus traps)
- hooks: `useDailyMissionDashboard.ts` (state, the single refs bag, the
  projection, the loader, initialization and the daily-reset clock),
  `useDailyMissionRealtimeCatchUp.ts` (the Phase 2 event-driven catch-up
  and the private broadcast subscription), `useDailyMissionActions.ts`
  (claim, freeze, reroll and claim-all with their guards), `useMissionCycleRoute.ts`
  (cycle route, title, club-aware navigation), `useInertAppShell.ts`

The page now composes those units and passes live data and callbacks only.

## Stylesheet

`src/pages/DailyChallengesPage.module.css` is a manifest of `@import`
lines over `src/pages/daily-challenges/*.module.css`, one partial per
family and cascade layer in the original order. postcss-import inlines
them before the module scoping runs, so every class is hashed in one scope
exactly as before (21 cross-family compound selectors depend on that).
Proof: the partials concatenated in manifest order equal the previous
file byte for byte, and the built chunk normalizes to an empty diff.

## Dead contracts removed

- `BIG_POT_MIN`: exported with no importer anywhere; the threshold lives on
  each catalog row.
- the catalog `icon` field and every `icon: ''` row: no reader; the
  instrument glyph is derived from the challenge type.
- the in-page signed-out card: unreachable, because the route's
  `AuthGuard` never renders the page without a session. The one reachable
  variant (the secure session check failed) renders the unavailable state
  with a "Retry Session Check" action.
- two unused classes and three never-read custom properties in the
  stylesheet; `--mission-ink` stays because it carries the pinned
  `--realism-carbon` fallback.
- the `src/components/challenges/index.ts` barrel, whose only reachable
  importer was the page.

## Tests

Source-text pins moved with the code through
`tests/helpers/dailyChallengesSources.ts`: a pin about one unit reads that
unit, and every surface-wide negative or count reads the stitched surface
(page plus units), so an extraction can never move a pinned behaviour out
of sight. The two rendering suites (subscription recovery, freeze
interaction) run unchanged.
