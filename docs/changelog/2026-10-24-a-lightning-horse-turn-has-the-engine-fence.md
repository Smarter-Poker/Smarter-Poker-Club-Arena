# A Lightning horse turn has the engine's fence (2026-10-24)

Found by the horse capability audit (Dan, 2026-10-24: "INSURE THAT EVERY SINGLE
ATTRIBUTE AND ABILITY A HORSE HAS TO MAKE REAL TIME DECISIONS ... IS TURNED ON").

## What was wrong

Every consumer of a horse turn's fence reads the physical engine's five parts,
`table:hand:seat:lease:turn` (`ServerTableEngineTurns.scheduleHorseAction`):

- `HorseMindHandIdentity.horseMindHandFromDecision`: the identity the worker
  passes to `HorseMind.observe` at the top of the decision, and the plan
  namespace (`horsePlanContextFromDecision`);
- `HorseDecisionHandBinding.anchorHorseDecisionHand`: the private decision
  journal, the execution journal and the committed-hand binding;
- `horseDecisionJournal/lifecycle.horseLifecycleKeys`: the request lifecycle.

`LightningHandHost.scheduleHorse` built `table:hand:seat:turn`. So on every
Lightning horse decision:

1. the in-hand opponent read was refused (an explicit null identity makes
   `HorseMind.observe` return without ingesting the hand), so a Lightning horse
   decided without what the current hand had already shown it;
2. `horsePlanHandKey` was null, so V7 barrel plans, V23 raise-response plans and
   the sizing plan notes had no hand to live in;
3. the decision, its execution witness and its lifecycle were all journal
   capture gaps.

Production telemetry 2026-10-22..24 (19.4M decisions): 1,725,367
`phase15_hand_binding_invalid_turn_identity`, and 5,176,830
`phase15_journal_capture_unavailable` - three gaps per refused decision
(decision record, execution record, lifecycle admission; 3 x 1,725,367 =
5,176,101).

## What changed

`lightningHorseDecisionFence` (LightningHorse.ts) builds the five-part fence
with the host table's verified cash lease generation (`deps.leaseFor`, the same
lease Lightning settlement fences on). Without a lease it writes `unverified`,
as the physical engine does, and the consumers refuse it by name.

## Pinned

`server/src/lightning/aLightningHorseTurnHasTheEngineFence.law.test.ts` plays a
real Lightning hand: every decision snapshot anchors, has a mind identity and a
plan namespace, and is keyable by the lifecycle journal. It fails on the old
host and passes now.

Engine runtime change: activates in the daily 04:00 America/Chicago window.
Complements open PR #7950 (Lightning completed hands reach the horse mind),
whose observation fence `host:hand:lease:observe` binds to these anchors.
