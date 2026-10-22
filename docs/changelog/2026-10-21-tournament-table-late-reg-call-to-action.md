# Tournament Tables Offer Late Registration, Never A Waiting List

Dan, 2026-10-21, with a screenshot of "Table Full · 0 Waiting / Join The Waiting List" under a running MTT: that call to action must never appear when watching a tournament. A tournament has no waiting list.

## What Changed

- `TablePage` spectator footer: every tournament table (other than a seat-first Sit & Go before it fills) now renders `TournamentLateRegCallToAction` instead of the waiting list button. A full seat-first table prints "Spectating · All Seats Taken".
- `TournamentLateRegCallToAction` prints, on the same painted action shell, "MM:SS Left Before Registration Closes" and "Tap Here To Register", counting down each second. The tap opens the tournament's page, which owns the real registration flow. The deadline is `lateRegEndMs`, the same projection the lobby cards use (level window end or configured clock, whichever is first). When entry is closed it prints "Spectating".
- The waiting list read at each hand boundary no longer runs on tournament tables.

## Pinned By

`tests/a-tournament-table-never-offers-a-waiting-list.law.test.ts`
