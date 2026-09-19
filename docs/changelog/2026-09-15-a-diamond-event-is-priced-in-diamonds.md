# 2026-09-15 - A Diamond event is priced in Diamonds, on the surfaces a player reads

Phase 8 of the Diamond build programme closed with one item still open, and the
programme said so in its own entry: "the lobby's projected ladder and sign-up
dialog still speak chips for a Diamond event (display only)". This is that item.

## What was wrong

Five browser surfaces price a finishing place - the lobby's projected ladder in
`GameLobbyPanel`, the in-table `TournamentInfoPanel`, the tournament page's two
ladders, and the Detail and Rewards tabs. All five go through one wrapper,
`placePrize` in `components/tournament/details/types.ts`, and that wrapper
answered on their behalf.

It passed `UNIT_CENTS_ASSET_NOT_READ` to `computePlacePrize`. That constant is a
cent, and it was the honest answer when it was written: no caller had read the
club's asset, and every tournament that could exist was a chip tournament. The
name existed precisely so this work could find the surfaces that had to learn
better - the wrapper's own comment said "when Diamond tournaments open, this
wrapper takes the unit from its callers". This is that commit.

The consequence was not cosmetic, which is what "display only" undersells:

- **Every share was rounded to a cent rather than to a whole Diamond.** A
  Diamond does not divide. The custody reserve floors it, the hand settler
  refuses it, and the wallet stores diamonds as an integer column. So the
  projected ladder for a Diamond event showed quantities that no door in this
  estate would accept. On a 513 Diamond pool over a nine-place structure, the
  cent grid produced fractional places; the test asserts that rather than
  describing it.
- **The short-field rule never engaged.** `computePlacePrize` has a branch for
  a pool holding fewer units than there are places to pay, and it is guarded by
  `unit > 1` - deliberately, because at cent granularity the case needs a
  nine-place event with a pool under nine cents and has never been reachable. At
  Diamond granularity it is one short field away, and without it first place is
  paid nothing while ninth absorbs the entire pool as its "residual".

`payoutMath.ts` opens with the sentence this is about: a player must never be
shown one number and paid another.

## What nobody lost

Nothing was ever shown wrongly to a player. Read from production on 2026-09-15:
one Diamond arena club exists, **zero Diamond tournaments have ever existed**,
and `ca_arena_settings.tournaments_enabled` is false. This was the gap that had
to close before the switch, not damage to be settled after it. The test says so
too, so the next reader does not have to infer it.

## The fix

**A tournament row is read with the arena it belongs to.**
`TournamentService.getTournament` and `getTournaments` now select
`arena:clubs!tournaments_club_id_fkey(id, asset, is_platform, union_id)` -
exactly the three columns `fn_ca_tournament_unit_cents` joins and tests, so the
browser answers "what unit does this pay in?" with the database's own rule
instead of assuming. `tables` has carried the identical embed since the Diamond
cash work; this is that idiom arriving at tournaments. The constraint is named
rather than inferred, because `clubs(...)` alone resolves only while
`tournaments` has exactly one foreign key to `clubs`, and the day it has two
PostgREST stops guessing - at runtime, on a player's lobby, not in CI.

**`placePrize` takes the unit from its callers and no longer answers for them.**
The parameter is required, not defaulted to the old answer: a default would be
the identical defect one level up from the one this phase removed from
`computePlacePrize` - every caller would keep compiling and the ladder would
keep printing cents. Required means `tsc` names every surface that has not
learned. It named all five, plus two typing holes worth having found:
`GameLobbyPanel`'s state and `TournamentInfoPanel`'s row type both claimed a
shape with no arena on it, so both would have read `undefined` and answered
"chips" with complete confidence.

**A Diamond prize prints as a whole Diamond.** `formatPrizeAtUnit` in
`utils/format.ts` keeps `formatTableChips` for chips - by construction, a unit
of 1 takes the first branch and nothing else runs - and prints whole Diamonds
otherwise, matching what `DiamondCustodyBalance` already does. It is not a
second rounding and must never become one: the arithmetic has already snapped
the value to the unit, and this only chooses how to say it.
`TournamentInfoPanel` and the tournament page print through `compactChips`,
which already floors to a whole number, so their display was never the defect -
only their arithmetic was.

## Why the census grew

`a-tournament-prize-knows-its-unit.law.test.ts` walks every caller of the four
unit-bearing money rules and proves the unit is passed and is never a bare
literal. It was green before this change and would have stayed green after it:
`placePrize` is a wrapper, not one of the four, so its own five callers were
outside the census. A sixth display added next month with
`placePrize(pool, places, 1, 1)` would have compiled, printed cents at a Diamond
event, and been indistinguishable from the default the law was written to
delete.

That is CLAUDE.md 10.86 rule 4 - a fix that leaves the same trap one level up
has not landed - so the wrapper joins the census, and
`components/tournament/details/types.ts` joins the list of files forbidden to
give a unit parameter a default.

## Verification

`npx tsc --noEmit` exits 0 across the client tree.
`tests/unit/aDiamondEventIsPricedInDiamonds.test.ts` - 12 tests, covering the
embed read as an object and as an array (an array reaching the object branch
would read `undefined` and become a silent "chips"), all three SQL conditions,
the whole-Diamond ladder, the pool summing back to itself exactly at the Diamond
unit, the short field, the chip path being untouched, and the printed text
carrying no decimal point for any place of any pool.
The five existing suites over this code - the unit law, the payout-copy law,
the pays-every-place law and both lobby-tab contracts - 171 tests, all green.

## What is still open for the switch

Unchanged by this commit, and listed so it is not mistaken for finished:
bounty and satellite formats are Phase 9 (bounties and mystery bounties are
built; satellites, spins, guarantees and promotional entries are not), and there
is still no isolated SQL fixture runner for the tournament lifecycle - the
evidence there remains the rolled-back production rehearsals and the law tests
that pin the migration text.
