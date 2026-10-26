# A rebuy offer is not a bubble

## What was wrong

A zero-stack player holding an unexpired rebuy prompt has no stack ICM can price yet, so `deriveContext` (TournamentBrainContext) marked the whole event's tournament context incomplete (`live_field_recovery_pending` plus `live_field_stack_cardinality_mismatch`) while any one offer was open. Offers last 30 s and snapshots live 20 s, so in a large rebuy MTT at least one offer is almost always open somewhere.

Measured live on 2026-10-26 (read-only): during the rebuy periods of the Sunrise Bounty and Morning Free Buy MTTs (150-350 players, 20-54 offered busts per 10 minutes), 20-80% of horse decisions on every table were made with tournament stage, ICM, bounty and payout context withheld. Sunrise Bounty 3675640e fell from 38% to 5% to 0% the moment its rebuy window closed at 13:48 UTC. The two issues have fired 150k-315k times a day since at least 2026-10-17.

## What changed

The pending seat still fails the context closed where it can move the money: within the existing near-bubble band of the paid places, at or below one table, in a satellite, or with no known payout. Elsewhere the field is priced without the pending zero stack (`playersLeft` matches the stack list) and the context stays complete. The near-bubble test uses the settled count, so the published `inMoney`, `nearBubble` and `finalTable` flags cannot disagree with it.

## Proof

`aRebuyOfferIsNotABubble.test.ts`: a big field with one or seven open offers stays complete and priced without them (both fail on the previous code); the bubble band and the final table still fail closed with both issues; a fixture control without offers is complete. The existing small-field fail-closed case is unchanged. Server tsc and the TournamentBrainContext, Phase 6 tournament, V37 satellite, blind snapshot, tournament and payout-capture suites pass (396 tests).
