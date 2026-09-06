# 2026-09-05 - Previous Hand build plan, Phase 4 of 7: one replayer everywhere

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. Builds on phases 1-3
(`52da71526` and before): one reconstruction, `HandRecord.replay`, rendered by
the panel, the modal, the archive and the animated replayer.

Phases 1-3 improved ONE of this platform's two replayers. This phase is about
the other one.

## There were two replayers, and only one of them knew any poker

`/share/hand/:handId` rendered `HandReplayerPage`, which was a complete second
implementation: its own `HandData` shape mapped by hand out of the service
record, its own action timeline, its own controls, a 3D felt behind it
(`HandReplay3D`, the app's only gsap consumer) and three analysis widgets
beside it. `/replay?h=<payload>` - the address every shared link actually
opens - rendered a third thing again: a flat list of seat numbers and verbs
down the page, with no felt at all.

Neither knew what the reconstruction knows. Measured on the pages as they
stood:

- **The board was indexed by STEP NUMBER.** `currentStep < 4` meant preflop,
  `< 6` the flop, `< 8` the turn. A hand whose preflop ran more than four
  actions dealt its flop in the middle of the betting; a hand that ended on
  the flop in three actions dealt all five cards. Nothing about that is a
  rendering detail - it is the page telling a player a card came on a street
  it did not come on.
- **1500ms a step, fixed.** The player's Animation Speed did not reach it.
- **No run-it-twice.** A hand that ran three boards replayed as one.
- **No dead money, no hi-lo halves, no rake, no jackpot drop, no discard
  street, no hand number.**

A second replayer is not a second feature. It is a second set of bugs on the
same hand, and it is why a defect fixed on one surface kept being reported on
another. Both routes render `HandReplay` now - the same component the table's
Previous Hand modal and the Hand Archive open, off the same model.

`HandReplay3D`, `src/components/hand-replayer/**` (PositionAnalysis,
OddsDisplay, ShareableHighlight) and `src/types/engine/handReplay.ts` are
retired: nothing else rendered them, and gsap leaves the BUNDLE with them -
nothing imports it, so it is tree-shaken out rather than shipped. The pin in
`tests/unit/bundleSurface.test.ts` stays, pointed the other way: nothing in
`src` may import gsap. The dependency itself is left in `package.json`
deliberately, because removing it rewrites the lockfile every open branch has
to merge, for install weight that never reaches a player. Drop it in a pass
that is doing lockfile work anyway.

## Share link v4: the recipient rebuilds the sharer's model

The link used to carry a thinner cousin of the hand. It now carries what the
reconstruction knows, and the recipient's page calls the SAME builder on it:

    shareableFromModel(model, meta)   the sharer's model -> the payload
    replayFromShareable(hand)         the payload -> the same model, via buildReplay

New on the wire, all of it absent before: run-it-twice and bomb-pot boards
2..N; per-board and per-half awards, so a hi-lo split reads as a split and a
three-board hand pays three boards; the rake and the jackpot drop; the hand
number; the discard street; the DEAD flag on forced money; and a bomb-pot
mark, because a reconstruction that cannot find blinds otherwise invents them
(the Phase 3 defect, hand #6704153, reproduced here as a test).

v4 amounts are the model's own INCREMENTS. v1, v2 and v3 payloads still decode
and are still read as the engine's raise-TO levels, which is what they carry -
`wireVersion` on the decoded hand is what says which. No link rots.

Five things the wire now refuses to do:

- **An unknown stack is empty, not zero.** `encodeMoney(undefined)` is `'0'`,
  so a hand shared from the archive - which carries no stacks - reached the
  recipient with every seat sitting behind nothing, presented as fact.
- **The sharer's own folded cards stay private.** They travel (so the sharer's
  own replay draws them) marked `p`, and rebuild into `privateHoleCards`. Fed
  in as ordinary hole cards they would have made a `show` row and put the
  sharer in a showdown that never happened.
- **A seat number is its leading digits.** `parseInt(token[0])` read seat 10 as
  seat 1 taking action `0` - an unknown code, so the row was dropped and that
  seat's whole hand vanished from the link.
- **A verb the wire cannot name is dropped, never renamed** - unless it moved
  chips, in which case dead money travels as an ante and anything else as a
  generic post that joins no bet level.
- **A returned uncalled bet is signed by its verb.** The model stores it
  negative; unsigned money on the wire clamped it to zero and left the
  uncalled bet in the recipient's pot.

## Four defects found on the way, in code this phase did not write

**1. The table shared four of the seven games as hold'em.** Every variant fix
so far landed on the archive's producer. `TablePage` - where a player actually
presses Share, on the hand they just played - kept
`['NLH','PLO4','PLO5','PLO6'].includes(st.gameType) ? ... : 'NLH'`, so a PLO8
hand shared from the felt arrived as NLH, and so did short deck and both
pineapples. That changes how many cards each seat holds and whether the pot
splits. Both producers use `toShareVariant` now, and
`tests/share-variant-and-discard-street.test.ts` pins the table as well as the
archive.

**2. The table shared every blind as an all-in.** The same function mapped
five verbs and ended `: 'ALL_IN'`, so a small blind, a big blind, an ante, a
straddle, a returned bet and a discard all reached the recipient as ALL IN,
carrying the blind's own amount. Share link v3 put forced money on the wire in
September and the archive sent it correctly; the felt was still relabelling
it. One table, and a verb with no entry is dropped.

**3. `reportError` threw, from inside the catch block that called it.**
Prefixing the context onto the message was an ASSIGNMENT to `err.message`, and
`DOMException.message` is a getter with no setter - while a DOMException _is_
an `instanceof Error`, so it reached that line. The reporter threw
`TypeError: Cannot set property message of which has only a getter`, the
original error was never reported, and a handler that was being careful about
one failure got a different one thrown back out of it. Every DOMException on
the platform is in that class: `atob` on a truncated share link (which is how
this was found), a storage quota, an aborted fetch, clipboard, IndexedDB, Web
Crypto. It copies rather than mutates now.

**4. A showdown row's `net` is not a pot share unless the record said who won
each board.** Without per-board awards the builder puts the player's
whole-hand NET on the board-one row, which is right for a rundown and wrong
for anything reading it as a share of the pot. This phase's producer read it
as a share and put 195 on the wire where the pot paid 201 - the winner's own
investment, subtracted twice, which is exactly the conflation
`winners[].amount` was corrected for on 2026-08-23. The model publishes
`perBoardAwards` now, because a consumer cannot tell those two numbers apart
by looking at them.

## Also

- `ReplayInput.startStacks`: a producer that KNOWS the starting stack says so,
  instead of handing over a settled figure the builder inverts back. A share
  link is written at the end of a hand and carries the start; it had no way to
  say that. Still gated on the rebuild reconciling - a true start stack cannot
  rescue a stack column whose subtractions are short.
- `HandReplay` takes a `ReplaySource` (the model plus the five facts the
  header and seat strip read that are not in it). A fetched row is folded into
  the same shape, so there is no second branch to keep in step. A hand handed
  over outright is never also fetched - reading the route for an id while
  holding a whole hand is how the share page would have asked the database for
  a hand its viewer is not allowed to read, and replaced a good replay with
  "Hand Not Found".
- The felt anchors on the SHARER's seat on a shared hand. The recipient is a
  different person, or nobody; without that the hand replayed from a chair
  nobody was sitting in.
- `/share/hand/:handId` still reads `hand_history` and RLS still applies, which
  is correct: that address is for the people who played the hand. The link a
  player shares with anyone else is `/replay?h=`, which needs no read at all.

## Pins

`tests/unit/previousHandPhase4.test.ts`: the full round trip on a hi-lo
run-it-twice hand with an ante, a rake and a drop - the second board, both low
halves per board, the rake, the drop, the hand number, the dead ante and the
raise still differenced against live chips only, and the rebuilt pot matching
the sharer's. Then what must never be gained: no invented showdown, no other
player's private cards, no fabricated stack, no invented blinds on a bomb pot,
no renamed verb. Then the wire itself: a two-digit seat, a v3 payload still
decoding as raise-TO levels, a corrupt payload refused rather than
half-read, blinds parsed out of a group-separated tournament stakes string.
Then that there is one replayer: both share routes render `HandReplay`, the
second replayer's files are gone, and a supplied hand is never fetched.
