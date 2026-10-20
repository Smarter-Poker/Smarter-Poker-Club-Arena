# tests/a-nightly-feature-is-pinned-only-on-its-day.law.test.ts

Dan, 2026-10-19: a featured tournament that runs more often than weekly (the Nightly 10K) is pinned to the top of the tournament displays only on the day it runs, or while it is running; tomorrow's and later instances are ordinary rows until their day. A weekly flagship with one instance on the board (the Sunday 200 Deep Stack) keeps its pin all week. The rule lives in `src/lib/featuredOnItsDay.ts` and every display that floats pinned events (the club lobby board, TournamentPage, TournamentLobbyPage) goes through it.
