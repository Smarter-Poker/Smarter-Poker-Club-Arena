# A horse's "no" closes its rebuy offer, like a human's Cancel (2026-10-24)

Found by the horse capability audit (Dan, 2026-10-24: every ability a horse
uses to make real-time decisions must be turned on, on every hand).

## What was wrong

`TournamentBrainContext` fails closed while any busted player in an event still
holds an open rebuy / re-entry offer: that player is counted in `playersLeft`
but has no stack an ICM calculation can price, so the context carries
`live_field_recovery_pending` and `live_field_stack_cardinality_mismatch` and is
`incomplete`. Phase 7 (the action-specific tournament ICM utility) then skips
EVERY decision at EVERY table of that event (`phase7_utility_skip_incomplete`).

Production telemetry 2026-10-22..24: 832,983 decisions carried both issues,
1,050,467 Phase 7 skips in all (of 11.09M tournament decisions).

The fail-closed rule is right (an open offer genuinely is not a bust). What
kept it open for no reason was the horse's input device: a human who declines
clicks Cancel, and `/reject_rebuy` calls `fn_decline_tournament_rebuy`, which
ends the offer at once. A horse that declined (25% of eligible busts since the
75% rule, or every bust once a Free Buy allowance is spent) only stopped asking;
its offer stayed open for its full 30 seconds, blinding the whole event's ICM
for that time.

## What changed

`TournamentManagerEliminations.declineHorseRebuyOffer`: a declining horse sends
`fn_decline_tournament_rebuy` (service role, the same row-locked transaction
and knockout generation a human's Cancel uses). Nothing prices, eliminates or
seats anybody here; a refusal or transport error is reported
(`Tournament.horse_rebuy_decline_unpersisted`) and the offer expires on its own
clock exactly as before. Humans are never declined on anybody's behalf.

## Pinned

`aHorseAnswersItsRebuyOfferLikeAClick.law.test.ts`: every declining horse's
offer is closed through that door, a willing horse never declines, a human is
never declined for, a refused decline changes nothing else, and a Free Buy
horse past its allowance declines. Three of these fail on the old code.

## Not claimed

Offers held open by humans, and the short window while a willing horse's
purchase commits, still (correctly) mark the context incomplete. Pricing an
open recovery option inside Phase 7 is hashed strategy work (the handoff of
2026-10-17 names it) and is not part of this change.

Engine runtime change: activates in the daily 04:00 America/Chicago window.
