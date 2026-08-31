# A harness for the seam between the engine and the hand

**2026-08-31 — Phase 3 of the live cash games audit**

## The gap

`HandController` has a property-test harness — `HandFuzzer`, 18,000 randomized
hands per run, asserting chip conservation and `sawFlop === (board >= 3)`.

`ServerTableEngine` has several tests that stub the controller out entirely;
`PacedAllInRunout.test.ts` replaces it with a literal object exposing three
methods.

**Nothing exercised the seam between them**, and two live defects were sitting
in it.

## Why the seam is where the bugs live

The engine keeps **two boards**, and the second is never derived from the first:

| | what it is |
| --- | --- |
| `HandController.state.communityCards` | what was dealt. Drives `sawFlop`, and through it the rake. |
| `engine.currentHandCommunityCards` | what `hand_history` stores. |

The stored board is assembled from `COMMUNITY_CARDS` events in
`ServerTableEngineHandEvents` (~588). So a dealing path that does not emit one
leaves the record empty while the felt shows five cards, and a path that sets
`sawFlop` without dealing charges rake on a hand that never had a flop. Neither
harness could see either, because one has no engine and the other has no
controller.

## What this adds

`server/src/engine/EngineRecordsWhatItDealt.test.ts` runs a **real
`ServerTableEngine` wired to a real `HandController`**, using the same
fire-and-forget subscription `dealHand` uses (`ServerTableEngineDealing` ~2285).
Only the outbound edges are stubbed — sockets, hub, database, clock. Everything
that decides what the hand *was* is the real code.

Three invariants, checked after every hand:

- **INV-1** — the stored board equals the dealt board.
- **INV-2** — `sawFlop` is true exactly when three or more cards are out.
- **INV-3** — under no-flop-no-drop, a hand with no flop is raked zero.

Five scenarios: a heads-up preflop walk (the shape of production hand
`50d4006e`, pot 4.00, raked 0.20), a multiway fold-out, a per-street runout —
the path insurance tables take, where 15 of the 16 empty-board hands sat — a
hand that genuinely reaches a flop and must still be raked, and a **detection
test** that injects `markFlopSeen()` with no board and asserts the invariants
catch it.

## What it does and does not show

**It does not yet reproduce either live defect.** All five pass. That is a
result, not a gap in the test: the ordinary fold-out, multiway fold-out and
per-street runout paths are **clean** through the real engine, so the live
trigger needs a condition these scenarios do not create.

What it rules in: `markFlopSeen()` remains the only writer of `sawFlop` that
deals no cards, it is called at the *top* of `dealAndResolveRIT` before any
card, and a path that reaches it and then does not deal produces exactly the
production signature — `sawFlop` true, board empty, rake charged, `rit_boards`
empty because the board loop never ran. All 20 production hands match that
signature. The detection test pins that state so it cannot ship silently again.

The next scenarios to add are the configurations this one does not build: bomb
pots, straddles, dead blinds, all-in-or-fold, and a hand voided by the safety
timer mid-RIT-offer — the last being the most promising, since a RIT callback
firing after a hand has already folded out would reach `markFlopSeen()` on a
hand with no board and no all-in, which is what the data shows.
