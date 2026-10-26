# A horse answers its rebuy offer like a click

Third root cause behind Dan's "276 entries and 9 rebuys" (2026-10-24), after
the 45% share (now 75%) and the bounty rebuy place collision (#7898, #7899).

## What was measured (09:06-14:50 UTC, after the 75% engine went live)

- Regular MTTs: horses chose to rebuy on 75% of eligible busts, exactly the
  rule, and the engine never bought in for a horse that declined. But only 48%
  of window busts were rebought.
- One event held most of the gap: Coffee Break Freeroll (PLO4), 149 players,
  85 horses chose to rebuy, 19 got in.
- 160 `Rebuy or re-entry decision window has closed` refusals in six hours:
  the horse's purchase reached the database after its 30 second offer expired.
  Busts in that freeroll waited 150-230 s for their elimination pass.
- Engine `/health`: main event loop p50 204 ms, p99 448 ms, governor at 0.35.

## Root cause

A human's rebuy answer is a click that goes straight to
`process_tournament_rebuy`. A horse's answer was only ever given inside the
elimination sweep, and every tournament's sweep is admitted through one
process-wide scheduler (four slots; ~300 managers registered at the 2026-09-27
peak) and stops at a five-second work budget, most of which its reads spend.
On a busy engine the horse "clicked" after its offer had closed. Same offer,
different answer window: a CLAUDE.md 10.5 violation.

## Fix

A zero-stack hand now also wakes `answerHorseRebuyOffersNow`, which reads the
event's open offers once and answers the horses through the same
`tryTournamentRebuys` the sweep uses (same window policy, draw, free-buy
allowance and atomic purchase door), outside the scheduler and its budget. It
answers only to manager stop and the maintenance freeze. Bursts coalesce into
one pass at a time; an unanswered willing horse (bust row not landed yet, or a
transient error) is asked again every 2 s, at most 16 passes, never past its own
deadline. The sweep's own rebuy call is unchanged; the purchase receipt is keyed
by the knockout generation, so whichever answer arrives second replays the first.

Pinned by `server/src/tournament/aHorseAnswersItsRebuyOfferLikeAClick.law.test.ts`.
Engine change: activates at the daily 04:00 Chicago release.

## Still open

`F06_SOURCE_EXCLUDED` (60 in the same six hours): a rebuy seated onto a table
whose break is in progress. Which seating path produces it is not yet read from
rows; not changed here.
