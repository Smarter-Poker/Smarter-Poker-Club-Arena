# Poker Arena Shell: Phase 5 Of 12

## Scope

One World Hub Poker Arena entrance opens the existing Club Arena application.
The existing carousel places Shark first and Diamond adjacent, retaining joined
clubs and their saved order/pins after those platform entries. A valid last club
remains selected; absent or retired selections fall back to Shark.

The original `public/cards/diamond-arena.png` from World Hub is copied unchanged
into Club Arena. SHA-256: `005bafc9488e6ceec214382e77701d4576914b1fae19bc4c78928ace4b6acede`.
It was visually inspected. No generated substitute is used for the Diamond card.
The World Hub umbrella card has a sibling Poker Arena asset with its heading updated.

Arena entry continues through ArenaAccessBoundary. Diamond receives its own
read-only release screen and shared wallet, with no Join or chip management.
Joined chip clubs keep the existing game cards and club-scoped filter/preferences
implementation. Funded Diamond games remain closed until subsequent gameplay phases.

The selector and exact club-lobby navigation now use the existing in-tab provider.
Only the lobby slot changes; table slots retain identity. In-tab Back restores
arena selection before using browser history. World Hub returns select the same
shared arena instead of booting a second application.

World Hub removes six standalone Diamond pages, its iframe, simulated screens,
exclusive preferences/store/CSS, and all navigation registrations. The dynamic
world fallback returns 404 for retired/unknown world IDs. Existing registered
worlds and supported aliases remain available. Cached standalone selection is
cleared during the existing store migration.

## Verification Before Push

- 95 focused client assertions passed: access boundaries, selector preferences,
  host-route preservation, carousel live updates and existing in-tab laws.
- Client TypeScript project build completed without diagnostics.
- World Hub initial focused run: 40 passed, four obsolete route-count checks failed.
  After the six-route retirement contracts were updated, all 18 assertions in
  the affected suites passed. Historical audit evidence is retained; removed
  sources are now explicitly asserted absent.
- No production balances, seats or database schema changed in this phase.

## Release Gate

OPEN until both normal repository pipelines publish and live desktop/mobile,
deep-link, back/refresh, auth-return and saved-state acceptance is recorded.
A pushed branch or merged pull request alone is not publication proof.
