# 2026-10-19 - A nightly featured event is pinned only on its own day

Dan, with a screenshot of the club lobby at 21:52 Chicago on Monday: "do not pin the nightly 10k guarantees for future days, only for the current day ... (sunday 200 stays, and 'todays 10K only' if its running, show it but never show the next days until its that day."

## Cause

The Nightly 10K schedule carries `isFeatured: true`, and the spawner (`ScheduledTournamentService`) copies that onto `is_pinned` for every instance it creates. A daily event is published 72 hours ahead, so on Monday night the Tuesday, Wednesday and Thursday Nightly 10Ks were all pinned and all floated above tonight's board with the FEATURED chip.

## Fix

`src/lib/featuredOnItsDay.ts` decides which pinned events float right now, per series (same club, same name):

- an event already under way keeps its pin;
- a series with one upcoming instance on the board (a weekly flagship, published six days ahead, like the Sunday 200) keeps its pin;
- a series with several upcoming instances (a nightly event) pins only the one that starts today in the viewer's calendar day.

Applied to the club lobby board (`LobbyTable`, which also drops the FEATURED chip from the rows it unpins), `TournamentPage` and `TournamentLobbyPage`. Nothing is written to the database and no job flips flags at midnight; the host's `is_pinned` choice is unchanged and the rule re-evaluates as the day turns over.

Pinned by `tests/a-nightly-feature-is-pinned-only-on-its-day.law.test.ts`.
