# An Event Nobody Entered Is Cancelled

Date: 2026-10-15

## What Happened

`TournamentNeverStarted` fired every hour on `poker_tournaments_overdue_start = 3`: three "Daily 25 Chip Freezeout" MTTs of a one-member pilot club with no horse in it, REGISTERING 7 to 55 hours past their start with zero entrants. Its daily schedule spawns one more every day. The same shape paged `HorseTournamentsOverdue` on 2026-10-05 (zero-entrant MTTs of a club under an operator hold, cancelled by hand the next morning).

## Root Cause

The discovery loop's past-start branch had no end for an event nobody entered and no horse could fill. It asked `topUpWithHorses` for a full field, got nothing (no horse in the club, or the club's fleet held), backed off to every ten minutes, and asked again for ever. "Tournaments run, they do not cancel" protects a player who paid for a game; an event with no entrant has nobody to protect and nothing to refund.

## Fix

`server/src/tournament/emptyPastStartEvent.ts` decides it: a registration-first event (never a seat-first Spin/SNG), pool not finalized, a complete roster read with no registered or playing entrant and a counter that agrees, at least 30 minutes past start, and a past-start top-up that has already come back empty. Such an event is cancelled through `atomic_cancel_tournament` (the database cancellation authority, which writes the immutable receipt and closes every bank at exact zero), asked at most every 30 minutes, refused loudly (`GameServer.empty_past_start_event_cancel_refused`). A club whose horses can fill the event is filled and played first.

## After #6910 (Re-Read Live 2026-10-15 06:40 UTC)

#6910 admitted and funded 72 horses into the pilot club at 05:31 UTC. An hour later the three events were still REGISTERING at zero entrants (59.6, 35.6 and 11.6 hours past start) and `poker_tournaments_overdue_start` still read 3: the club's events-lane horses were all seated in its own Spins and Heads-Up games, and the free ones are cash-lane horses the MTT fill does not take. Horses in the club do not give such an event an end; this rule does, and it still lets the top-up fill and play any event the club's horses can fill.

## CI Repair

The first cut kept the cancel retry clock in a new class field. The discovery-walk harnesses build a `GameServer` without its constructor and list its maps by hand, so the walk's prune step threw on the missing map and twelve walk tests in `theWalkReadsTheFleetOnce.test.ts` failed. The retry time now rides the existing `pastStartTopUpClock` entry (`cancelAskedAt`), pruned with the event, and the walk test counts the cancellation as the third owned launch beside the two funding callbacks. A walk-level test drives the real discovery pass on the production shape and pins one `atomic_cancel_tournament` call, no top-up and no second ask inside the retry window.

## Tests

`server/src/tournament/anEmptyPastStartEventIsCancelled.test.ts` pins every condition of the predicate and the wiring (complete roster read, top-up backoff, cancellation only through `atomic_cancel_tournament`, ahead of the top-up).
