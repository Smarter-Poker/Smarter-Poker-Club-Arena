# A horse declines its rebuy like a click

Follow-up to `2026-10-24-a-horse-answers-its-rebuy-offer-like-a-click.md`.

## What was measured

At 19:53 UTC on 2026-10-24 a horse in a PKO event busted and tried to rebuy
eight times inside its 30 second offer. Every attempt was refused with
`pko_predecessor_not_ready`, and the horse was eliminated. The blocker was
the knockout that horse had won 42 seconds earlier: 99d046ab busted at
19:52:58, its offer closed at 19:53:28, and its candidate row was still
`pending` past 19:54:06. A rebuy must wait until the knocker's earlier bounty
is claimed, so the second horse's rebuy could not go through.

99d046ab was a horse whose draw said "no". It is one occurrence in 24 hours.

## Root cause

When a human clicks "No", POST /reject_rebuy calls
`fn_decline_tournament_rebuy`. That closes the offer at once
(`rebuy_prompt_until = now`) and wakes the tournament manager. A horse's
"no" only lived in the engine's memory. Its offer stayed open for the full
30 seconds, and then the bust waited for the next elimination sweep, which is
slow on a busy engine. That is a different treatment of the same answer
(CLAUDE.md 10.5).

## Fix

`tryTournamentRebuys` now sends `fn_decline_tournament_rebuy` for every horse
whose answer is "no". That covers the draw saying no and the free-buy
allowance being spent. It is the same RPC with the same effect, sent only
while the manager is running and outside the maintenance freeze. A refused
decline is reported and leaves the offer to expire at its own deadline,
exactly as before. Willing horses and humans are untouched.

The engine change activates at the next daily 04:00 America/Chicago release.

Pinned by `server/src/tournament/aHorseAnswersItsRebuyOfferLikeAClick.law.test.ts`.
