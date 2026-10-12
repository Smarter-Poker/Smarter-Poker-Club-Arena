# Live-table review residuals (2026-10-05)

A second review of #6105 found six small leftovers. All are fixed here.

## Table page

- **An ALL IN press the engine plays as a call no longer counts as a preflop
  raise.** The press paints an optimistic `all_in` label, and the lastActions
  effect counted any non-call verb as a raise. That effect now counts only
  `bet` and `raise`. A real shove is counted from the hero's own PLAYER_ACTION
  echo, which carries the verb the engine executed, and only when it puts in
  more than any other seat's bet. A short all-in that only calls is not a
  raise.
- A finished hand no longer keeps the `seat-wrapper--showing` lift. It now
  follows `feltShowsNoHand`, as the cards do.
- The comment in the removed `handleAllIn` block no longer says the panel path
  sets all-in mode.

## "+" sheet and lobby tab

- **A cash "+" no longer lands on a tournament list that an earlier request
  left the lobby page on.** A landing marks the tab (`lobbyLandedList`), and
  consuming the landing does not clear the mark. A plain lobby request on a
  marked tab clears the mark and takes a fresh nonce, so the page remounts on
  the player's saved tab.
- **A stale "+" press writes nothing.** Each press takes a run number, and
  each close of the sheet retires it. After every await the handler checks the
  run number. A press the player dismissed, or one that a newer press replaced,
  can no longer paint rows into the new sheet or switch to the lobby tab late.
- The spin read is now timed like every other read in the sheet, so a stalled
  read cannot leave the sheet on "Finding Games".
