# The Discard a Horse Chose Is the One Its Next Decision Reads

October 5, 2026. Horse Brain Phase 12, package P12-A, first slice. Tests only.

Crazy Pineapple deals three cards and takes one away on the flop. The card that goes is
private, it is dead for the rest of the hand, and the horse's next decision has to know
it: a sampler that can redraw the card its own hand threw away is pricing a board that
cannot happen.

Every piece of that was already held by a test. The controller's private retention, the
worker's refusal of a two-card flop with no authoritative discard, the sampler's refusal
to redraw a supplied dead card, and the snapshot builder forwarding one. What nothing
held was the join: the builder's case replaced `getPineappleKnownDeadCards` with a stub
returning a card no controller ever accepted, wrote the discard into the action history
by hand, and assigned the hero's two cards itself. A fabricated discard passed all of it.

`PineappleAcceptedDiscardChain.test.ts` carries one real accepted discard the whole way.
A real `HandController` deals, `performDiscard` is accepted at a chosen index, the real
`scheduleHorseAction` builds the next decision from that controller, and the snapshot it
publishes goes to a real decision worker on the engine's own key. The worker accepts it,
and the frozen player it hands the brain holds the retained pair and that one dead card.
Two streets later, on the turn, it is still the same card. Each seat has its own, and a
refused second choice does not change what the next decision reads.

Three cases then take the same real snapshot apart: remove the private dead card, remove
the accepted discard from the history, or substitute a card the hero still holds, and the
worker refuses each by its exact name. That is what makes the positive case worth having.

Measured by mutation. Publishing `knownDeadCards: []` from the engine turns 4 of the 10
cases red; deleting the worker's proof requirement turns 1 red. Both mutations reverted.

Not claimed: no Pineapple policy is qualified, no pack is selected, nothing is promoted,
and no production window was observed. The forced-runout discard has no subsequent
betting turn and keeps its existing owners. Record:
[`docs/horse-brain-phase12a-accepted-discard-chain-2026-10-05.md`](../horse-brain-phase12a-accepted-discard-chain-2026-10-05.md).
