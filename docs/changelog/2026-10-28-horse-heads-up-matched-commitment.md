# Cash heads-up commitment uses matchable exposure

The reference decision could treat the same cash heads-up hand as committed
with 35 chips behind and uncommitted with 1,000 behind, although its opponent
could match only 35. A retained `foldToRaise` plan also folded only the
covering horse because its investment fraction used the surplus stack.

The qualified context now uses
`min(hero.stack, opponent.stack + opponent.bet - hero.bet)`
for the existing SPR and investment commitment rules. Actual stack still
governs legality and every tournament policy. The committed wager becomes an
explicit canonical raise, rather than a shove of the covering stack. Where
matching the opponent would be an under-minimum raise, the minimum legal
raise is submitted and the controller returns its unmatched excess. Missing
raise rights preserve a call. Existing `callOnce` and river-flat rules run
before this wager and remain effective.

This change requires canonical state, explicit cash NLH with no-limit betting
or high-only PLO4/5/6 with pot-limit betting, one board, and exactly one nonfolded opponent who can respond. It excludes
tournaments, hi-lo Omaha, fixed limit, binding whole-hand commitment caps,
bomb pots, multiboard play, additional all-in contenders, all-in-only opponents and legacy snapshots. It does not claim
universal stack invariance, improved profit or a complete repair of decisions
against aggressive players. Existing Omaha nut, dominated-hand, scare-runout
and retained-plan rules still decide whether to call, fold or apply pressure.

Verification includes two actual-decision regressions failing on main
`65e596b816427eb0ea55d28d06a6cfa8488edea0`: a low-SPR wager/call difference and
a retained-plan call/fold difference. A corrected nonadaptive seeded matrix
of 180 isolated decisions has 64 covering-stack action-class differences on
that baseline and zero on the candidate. These are fixture observations,
not a strength or win-rate measurement. Tests also cover excluded domains,
binding cap exclusion/no-raise rights, contradictory cap/call/exposure inputs,
invalid chip units and fractional bounds, and `callOnce` on each street. Real controller actions establish the canonical
menus and accept both short all-in and covering raise-to-40: each matches 35
additional chips, with five unmatched chips returned to the covering horse.
Controller cards are naturally dealt in that acceptance test; it does not
claim a forced AQ board through a deterministic controller deal.

The helper enters the shared reference source closure so future helper-only
changes invalidate dependent feature and phase qualification digests. Tests
run through the existing server Vitest inclusion. No database changes or
runtime activation are included in this source correction.

## High-only Omaha qualification

The archived real-controller matrix establishes PLO4/5/6 pot-limit bounds:
35 behind can legally move all in; a covering actor uses a full raise to 40,
with 5 unmatched returned. A larger 182 exposure reaches only the canonical 96
pot ceiling on this street. The helper now emits that explicit bounded raise
instead of relying on the controller to normalize an oversized all-in.
Targets round up to the minimum and down to the legal maximum in chip units.
No raise rights means call; a sole all-in opponent and every third contender
remain outside this qualification.

Three fixed-hand chooser cases reproduced short-stack all-in versus covering
call on the NLH-only baseline: PLO4 top set, PLO5 nut flush and PLO5 full house.
The same cases now use all-in 35 versus explicit raise 40, accepted with exact
action identity by separate natural-card controllers and conserving 106 total.
Fixed cards are independent chooser fixtures, never injected into the controller.
Dominated flush, retained callOnce, no-reopen, pot ceiling, invalid chip/cap and
excluded-domain controls remain covered. No new feature flag or prior is enabled.

The historical October16 opponent-exploit neutrality replay isolates this
independent repair at its pure helper boundary, as it does other later policy
repairs. Its original before-layer corpus, random-draw comparisons, every
variant/mode and greater-than90-percent coverage assertion remain unchanged.
Production has no opt-out; the repaired helper runs in its connected tests.
