# An Event Nobody Entered Is Cancelled

Date: 2026-10-15

## What Happened

`TournamentNeverStarted` fired every hour on `poker_tournaments_overdue_start = 3`: three "Daily 25 Chip Freezeout" MTTs of a one-member pilot club with no horse in it, REGISTERING 7 to 55 hours past their start with zero entrants. Its daily schedule spawns one more every day. The same shape paged `HorseTournamentsOverdue` on 2026-10-05 (zero-entrant MTTs of a club under an operator hold, cancelled by hand the next morning).

## Root Cause

The discovery loop's past-start branch had no end for an event nobody entered and no horse could fill. It asked `topUpWithHorses` for a full field, got nothing (no horse in the club, or the club's fleet held), backed off to every ten minutes, and asked again for ever. "Tournaments run, they do not cancel" protects a player who paid for a game; an event with no entrant has nobody to protect and nothing to refund.

## Fix

`server/src/tournament/emptyPastStartEvent.ts` decides it: a registration-first event (never a seat-first Spin/SNG), pool not finalized, a complete roster read with no registered or playing entrant and a counter that agrees, at least 30 minutes past start, and a past-start top-up that has already come back empty. Such an event is cancelled through `atomic_cancel_tournament` (the database cancellation authority, which writes the immutable receipt and closes every bank at exact zero), asked at most every 30 minutes, refused loudly (`GameServer.empty_past_start_event_cancel_refused`). A club whose horses can fill the event is filled and played first.

## Tests

`server/src/tournament/anEmptyPastStartEventIsCancelled.test.ts` pins every condition of the predicate and the wiring (complete roster read, top-up backoff, cancellation only through `atomic_cancel_tournament`, ahead of the top-up).
