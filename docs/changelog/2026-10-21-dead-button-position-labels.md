# Dead Button Hands Wore The Wrong Position Badges

Dan, 2026-10-21, two screenshots of Midweek Mystery Table 17: Burls showed
"CO" on hand #43306703 and again on hand #43307529.

## What The Hands Actually Were

Read from `hand_history` for table `a921f830-7c91-4812-9d63-f8eb37d6a8fb`:

| Hand     | Button       | Small Blind     | Big Blind       |
| -------- | ------------ | --------------- | --------------- |
| 43305776 | 7            | 8 (sixes)       | 9 (Burls)       |
| 43306703 | 8 (empty)    | 9 (Burls)       | 1 (Papa Tilt)   |
| 43307087 | 9 (Burls)    | 1               | 2               |
| 43307529 | 1            | 2               | 4               |

Seat 8 busted after posting the small blind. Under the tournament dead button
rule (TDA Rule 30, `server/src/engine/deadButton.ts`) the big blind advanced
to seat 1, the seat that had posted the big blind (Burls, seated since 02:58
UTC) posted the small blind, and the button sat on the empty seat 8. Burls was
a veteran of the table, owed that small blind, was correctly dealt in, took
the button next hand and was correctly the cutoff on hand #43307529.

## The Defect

`positionLabelsFor` could not find the empty button seat among the players and
fell back to "the lowest seat is the button". On hand #43306703 every badge
moved: seat 1 (the big blind) became BTN, seat 2 SB, seat 4 BB, and Burls,
posting the small blind, wore CO. That is what made a correct deal look like
a player dealt in between the blinds.

`derivePosition` in `handFacts.ts` (the recorded per-hand stats) had the same
fault in a different direction: it made the next occupied seat the button, so
the small blind was recorded as BTN.

## The Fix

- The engine now passes the hand's posted blind seats
  (`HandController.getBlindSeatsSnapshot`) into the projection, and a dead
  button hand is labelled from them: SB on the small blind poster, BB on the
  big blind poster, no BTN, the seats between named UTG through CO. Without
  the posted seats it walks clockwise from the empty button seat, the same
  walk the hand uses.
- `derivePosition` keeps the empty button seat in the order, so the seat after
  it is the small blind.
- Pinned by
  `server/src/engine/presentation/aDeadButtonHandIsLabelledFromItsBlinds.test.ts`.
  The projection equivalence test no longer compares dead button hands with
  the frozen copy, which is the behaviour being replaced.

## The Deal Itself Is Unchanged

Holding a seated tournament player out of the hand in which their small blind
falls would let them skip a blind they owe and break the rotation that makes
every seat pay once per orbit. The deal on both hands was correct.
