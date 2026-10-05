# Horse Brain Phase 12, P12-A: the accepted-discard chain reaches the next decision, October 5, 2026

Horse Brain only. This record covers the first slice of package P12-A of the
[maintained completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md#p12-a--finish-the-accepted-discard-evidence-chain-without-changing-its-owner):
finish the accepted-discard evidence chain **without changing its owner**. It uses the
maintained gate vocabulary (verified now / implemented but unverified / defective /
unavailable external input / not applicable with reason / historical only). Nothing is
averaged into a percentage.

**Outcome: one link of the chain was unproved and is now proved. Nothing else changed.**
No source file outside the new test was touched, no policy was qualified, no pack was
selected, and the discard's owners are unchanged.

## Where Phase 12 stood when this slice began

Phase 12's bounded core is implemented ([round 1](horse-brain-phase12-round1.md)). The
completion plan's P12-A/P12-B/P12-C packages are not. On `origin/main` at
`715713d803` there is no `HorsePhase12Authority.ts`, no Phase 12 input-binding test, no
Phase 12 strength contract, assembler or league workflow, and no Phase 12 completion
record, in contrast with Phases 10 and 11, which have all of those. P12-A is the first
package in the plan's order for this phase, and it needs no owner decision.

## The link that was missing

P12-A states the chain as: three-card request → exact chosen index/card → controller
acceptance → retained two-card state + private dead card → subsequent betting
sample/read frame.

Every link had tests. The join between the last two did not:

| Existing owner                                                         | What it proves                                                                                     | Where it stops                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PineappleDiscardFold.test.ts`                                         | A real `HandController` retains the chosen card privately, refuses a second choice and a bad index | At the controller. No decision is ever built from that state                                  |
| `horseDecision/workerRuntime.test.ts`                                  | The post-discard refusals and the decision-key binding                                             | Against hand-built `pineappleRequest` fixtures                                                |
| `HorseDecisionEffectCommit.test.ts` (the two-card Pineapple flop case) | The snapshot builder forwards a dead card                                                          | `getPineappleKnownDeadCards` is a `vi.fn` returning a fabricated card, with a written history |
| `PineappleDeadCardEquity.test.ts`                                      | The sampler cannot redraw a supplied dead card                                                     | The dead card is supplied by the test, not by the controller                                  |

So a fabricated dead card satisfied every one of those suites, and nothing carried one
really accepted discard from `performDiscard` into a request the live worker admits.

## What was added

`server/src/engine/PineappleAcceptedDiscardChain.test.ts`, ten cases, tests only.

A real `HandController` (`gameVariant: 'pineapple'`, four seats, 1/2, dealer seat 1)
deals three cards to every seat, and `performDiscard` is accepted at the hero's **chosen
index 1**, so a "discard the last card" default cannot pass. The receipt from
`observeNextPineappleDiscard` names the card at that index. The real
`ServerTableEngineTurns.scheduleHorseAction` then builds the next decision from that
controller, with nothing replaced; the snapshot it publishes is handed to a real
`HorseDecisionWorkerRuntime`, which is the component that refuses a post-discard state
without authoritative proof, carrying **the engine's own `decisionKey`** unmodified.

Proved positively:

- the receipt's card is the card at the chosen index, and the controller retained the
  other two in their dealt order;
- the engine snapshot's hero holds exactly those two cards and exactly one dead card,
  which is the accepted one;
- the discarded card appears nowhere in the public half of the snapshot: every public
  seat has no cards and no `knownDeadCards`, no board holds it, and the serialized
  `gameState` does not contain it;
- the real worker returns `FAST_RESULT` on that snapshot and the engine's own key, and
  the frozen player it hands the brain carries the retained pair and the accepted dead
  card, which is the sample and read-frame input;
- a real `HorseLogic.decide` completes on that real post-discard state and returns an
  action the snapshot declared legal;
- two streets later, on the turn of the same hand, the request still carries the same
  dead card and is still accepted;
- each of the four seats carries its own distinct accepted card, never another seat's;
- a refused second discard leaves the next decision reading the first accepted card.

Proved negatively, on the same real snapshot:

- with the private dead card removed, the worker refuses with
  `horse state known discard or physical cards are invalid`;
- with the accepted discard removed from the action history, the worker refuses with
  `horse state pineapple post-discard cards lack authoritative discard proof`;
- with a card the hero still holds substituted as the dead card, the worker refuses.

## That the cases assert, measured

Two deliberate mutations on this worktree, reverted immediately (`git status` clean
afterwards, only the new file added):

| Mutation                                                                             | Result                      |
| ------------------------------------------------------------------------------------ | --------------------------- |
| `ServerTableEngineTurns` publishes `knownDeadCards: []` instead of the accepted card | 4 of 10 cases fail, 5 pass  |
| The worker's `lack authoritative discard proof` throw is removed                     | 1 of 10 cases fails, 8 pass |

Without those mutations: `Tests 10 passed (10)`, 41 ms.

## Gate ledger for this slice

| Gate               | P12-A first slice                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | verified now: Crazy Pineapple cash, four dealt seats, flop and turn. Other seat counts, the river and tournament Pineapple (unavailable) are not covered here |
| G2 Inputs          | verified now: the inputs are the real controller's own, with nothing stubbed on the production path                                                           |
| G3 Calculation     | not applicable with reason: this slice adds no calculation. P12-B owns the net-action economics                                                               |
| G4 Authority       | not applicable with reason: no Phase 12 pack is selected and this slice does not propose one                                                                  |
| G5 Actual use      | implemented but unverified: these are source tests. No natural production window was collected for P12-A                                                      |
| G6 Outcomes        | verified now: both worker refusals fire by exact name on real data                                                                                            |
| G7 Correctness     | verified now for the join; mutation-checked both ways                                                                                                         |
| G8 Work and replay | not applicable with reason: no budget or replay claim is made by this slice                                                                                   |
| G9 Promotion       | not applicable with reason: nothing here is a strength result                                                                                                 |

## What P12-A still owes, and is not claimed here

- The **forced-runout** discard (an all-in Pineapple hand prepared before the flop) has
  no subsequent betting turn to reach, so it is not part of this join. It keeps its
  existing owners: `HorseDiscardControllerReceipt.test.ts` (forced receipts on actual
  commit) and `services/horseDecisionJournal/discard.test.ts` (the forced runout receipt
  from the actual flop commit). A chosen-versus-forced contrast of the private record at
  the join is still uncovered.
- **Natural accepted/forced/missing-capture receipts** through the existing route, which
  P12-A also asks for, need a production observation window and are not collected here.
- P12-B (per-variant economics on the canonical rule matrix) and P12-C (per-pack
  acceptance and natural evidence) are untouched.

## What was deliberately left alone

Phase 11's closure was in flight while this was written: three
`horse-phase11-strength-league.yml` runs were dispatched on `cf10fe839c` at
2026-10-05T00:49Z and a separate worktree held the Phase 11 completion record. Nothing in
this slice touches Phase 11 source, its records or its evidence.
