# A Slow Tournament Move Does Not Park Another Table

## Scope

This is the root correction for the Phase 1 production certificate's MTT
continuity failure. It does not change the 45-second causal-gameplay limit,
the seat-move receipt protocol, the move retry budget, table balancing, or any
player-facing design.

## What Existed

`TournamentManager.executePlayerMovesOwned` claimed every source-table move
boundary before it sent the first seat-move request. The requests then ran
serially. An ambiguous first response correctly kept its immutable request UUID
and performed two bounded calls plus a receipt-only lookup, but every unrelated
source table had already been parked for that entire uncertainty envelope.

The production event journal showed the result: one healthy, subscribed MTT
table emitted its normal hand-boundary events, then stayed causally silent for
46.509 seconds before the next hand. The socket did not fail and no animation
held the browser. That is a real continuity defect, so the certificate remains
strict rather than accepting the delay.

## What Changed

The manager still plans one ordered batch and still keeps one physical boundary
across every move from the same source. It now claims only the source it is
about to process, resolves every move for that source, and releases that source
before claiming the next one. If a result is unknown, only that exact source
stays fenced with its original request UUID and no later source is claimed from
the stale plan.

The durable receipt, idempotent replay, refusal behavior, whole-break custody,
and destination wake remain unchanged.

## Regression Protection

`TournamentMoveManagerBoundary.test.ts` now proves both sides of the failure:

- a pending first-source request cannot park a second source, and the first
  source is released before the second is claimed;
- an unknown first-source result retains its exact input and fence while the
  second source is never claimed or executed.

Focused local verification on the exact candidate passed 84 of 84 server
tests across the move-boundary suite, the no-false-detector law, and the
tournament fixes guard. The server TypeScript build also passed. Protected
merge, exact engine activation, and a fresh green two-lane production
certificate remain required before this correction is live proof.
