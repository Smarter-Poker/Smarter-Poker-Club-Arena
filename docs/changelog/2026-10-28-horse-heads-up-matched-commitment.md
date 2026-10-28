# Cash NLH heads-up commitment uses matchable exposure

The reference decision could treat the same cash heads-up hand as committed
with 35 chips behind and uncommitted with 1,000 behind, although its opponent
could match only 35. A retained `foldToRaise` plan also folded only the
covering horse because its investment fraction used the surplus stack.

The qualified context now uses
`min(hero.stack, commitmentCapRemaining, opponent.stack + opponent.bet - hero.bet)`
for the existing SPR and investment commitment rules. Actual stack still
governs legality and every tournament policy. The committed wager becomes an
explicit canonical raise, rather than a shove of the covering stack. Where
matching the opponent would be an under-minimum raise, the minimum legal NLH
raise is submitted and the controller returns its unmatched excess. Missing
raise rights preserve a call. Existing `callOnce` and river-flat rules run
before this wager and remain effective.

This change requires canonical state, explicit cash NLH, no-limit betting,
one board, and exactly one nonfolded opponent who can respond. It excludes
tournaments, PLO, fixed limit, bomb pots, multiboard play, additional all-in
contenders, all-in-only opponents and legacy snapshots. It does not claim
universal stack invariance, improved profit or a complete repair of PLO
decisions against aggressive players. PLO requires separate canonical
pot-cap/reopening and Omaha-policy qualification before extending this helper.

Verification includes two actual-decision regressions failing on main
`65e596b816427eb0ea55d28d06a6cfa8488edea0`: a low-SPR wager/call difference and
a retained-plan call/fold difference. A corrected nonadaptive seeded matrix
of 180 isolated decisions has 64 covering-stack action-class differences on
that baseline and zero on the candidate. These are fixture observations,
not a strength or win-rate measurement. Tests also cover excluded domains,
canonical cap/no-raise rights, invalid chip units and fractional bounds, and
`callOnce` on each street. Real controller actions establish the canonical
menus and accept both short all-in and covering raise-to-40: each matches 35
additional chips, with five unmatched chips returned to the covering horse.
Controller cards are naturally dealt in that acceptance test; it does not
claim a forced AQ board through a deterministic controller deal.

The helper enters the shared reference source closure so future helper-only
changes invalidate dependent feature and phase qualification digests. Tests
run through the existing server Vitest inclusion. No database changes or
runtime activation are included in this source correction.
