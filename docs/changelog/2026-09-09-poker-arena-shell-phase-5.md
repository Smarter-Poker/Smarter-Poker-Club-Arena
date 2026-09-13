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

CLOSED for the Phase 5 shell deliverable, with the explicit verification limits below.
Both runtime repositories are published and the scoped live repair check passed.
Funded Diamond gameplay remains outside this phase.

## Published Implementation And Final Repair

- Club Arena PR #4048 merged as `bc72ffc6820d3ab057f4617340389ec3189d0e6c`; final in-tab footer repair PR #4054 merged as `d600427ddcc08df214044ae2a8fbf27b41687c4c`.
- Both `https://ca-static.smarter.poker/build-info.json` and `https://smarter.poker/hub/club-arena/build-info.json` served exact repair commit `d600427ddcc08df214044ae2a8fbf27b41687c4c`, built September 10, 2026 at 00:00:16 UTC. Publisher [34419207566](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34419207566) completed publish-to-origin successfully. The optional Capgo job was skipped.
- World Hub PR #1701 merged as `606a789e16944b8a7bdc63789a46072a01bd4dc2`; footer test update #1702 merged as `e45cc7a43ba5e4c1feb78e19dc86118694f65a29`; evidence #1704 merged as `b1250716eb3d78fb692d183aebf8e9c707275e0b`. Production health identified exact `b1250716` on deployment `dpl_DVfnoUL4JYx9VXhrg1JidcdnEWgV`; it was healthy at September 9, 23:56:56 UTC.
- Delivery uses Club Arena's existing Caddy/Hetzner static publisher and World Hub's existing rewrite. Phase 5 has no server or SQL change and needs no engine restart.

## Final Required Checks

- Original Club Arena CI [34415463526](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34415463526): 18,165 client tests, TypeScript, structural/stub checks, production build, 150 CSS, 13 Studio and 3 mobile browser cases passed.
- Final repair CI [34417446410](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34417446410): 18,179 client tests across 1,316 files, TypeScript, structural/stub checks, production build, 150 CSS, 13 Studio and 3 mobile browser cases passed. Server, SQL, live-production and postdeploy jobs were skipped, not passed. Local repair checks passed 46 assertions; normal pre-push checks passed 1,050 assertions.
- World Hub build safety passed 1,613 tests and TypeScript. Final normal-pipeline browser run [34417851128](https://github.com/Smarter-Poker/Smarter-Poker-World-Hub/actions/runs/34417851128), job 102686601950, passed 16 footer, 27 premium menu, 32 mobile menu and 12 mobile performance checks. Earlier unchanged Training browser failures are retained in the World Hub audit; no test limits or Training runtime were changed to obtain this pass.

## Authenticated Production Acceptance

- Shared root displays Poker Arena and original Diamond artwork; joined clubs remain available. Diamond selection survives return to the selector and refresh. Shark joined lobby uses existing live games. Focused access tests cover nonmember Shark, automatic Diamond membership, auth return and malformed/retired saved selections.
- Diamond slug, UUID finance and agents routes show automatic membership, closed games and shared Diamond balances (available 494,465, in play 0); no Join or chip management. The old invite automatically reaches the shared Diamond selection.
- World Hub menu contains one Poker Arena entrance. All six retired standalone Diamond routes returned HTTP 404 at September 9, 23:31:28 UTC; the new umbrella card returned HTTP 200 image/png and was visually inspected. No standalone iframe remains.
- Final repair acceptance on exact production `d600427d`, September 10 approximately 00:04-00:06 UTC: open a spectator table, Browse Full Lobby, Choose Arena, select Diamond, Back to selector, select Shark, return to the original table. URL stayed `/hub/club-arena/table/bd52ccec-b670-4e22-a64c-858345020584` and the NLH 1/2 table slot remained present throughout.
- Diamond and selector have no fixed Settings/Players/Cashier/Market/Data/Stats footer. Returning to Shark scopes all six footer targets to `shark-club`, rather than the home club. The same spectator table advanced from hand 8784789 to 8784927. No balance, seat or game mutation was performed.

## Verification Limits

- The managed browser disables WebGL. The World Hub 3D canvas could not render before or after this change; its registry, navigation and served card asset were verified, but a rendered 3D-carousel visual check is not claimed. Desktop shared-shell inspection and the required mobile/browser suites passed.
- Existing table settings read timed out once at 00:05:47 UTC; earlier spectator checks also logged a hole-card recovery read and heartbeat 404. The relevant table/settings/API files are unchanged by this phase and the observed game continued. Extension metadata errors originate from the browser extension. These observations are not represented as zero-error browser execution or as proven Phase 5 regressions.
- At 00:07:08 UTC World Hub health returned 503 solely because its database health probe timed out at 3 seconds; served source stayed `b1250716`. A fresh recheck at 00:08:35 UTC returned HTTP 200, status ok and database ok (799 ms) on the same deployment. No database configuration or timeout limit was changed.
