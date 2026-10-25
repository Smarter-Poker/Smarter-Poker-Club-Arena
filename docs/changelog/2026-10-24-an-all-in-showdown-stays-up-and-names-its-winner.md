# An all-in showdown stays up two seconds longer, and names its winner (2026-10-24)

Dan, verbatim: "WHEN PLAYERS ARE ALL IN, ON THE RIVER, KEEP THE CARDS SHOWN FOR
2 MORE SECONDS, AND PROPERLY DISPLAY AND ANNOUCE THE WINNING HANDS BETTER..."

## What was wrong

The 2026-09-07 cadence halving left a heads-up showdown about 3.5 s from the
winner being decided to the board clearing, and the winner's name was on the
band for roughly two of those seconds. On an all-in, the hand everybody is
watching, the river landed, the band appeared, and the felt was swept before
the table had read it.

The announcement itself was thin:

- the band said WHAT won ("Full House") but never WHO;
- only the winner's seat named its hand, so a beaten hand sat face up with
  nothing saying what it was, although the engine's `showdown` event has
  always carried every tabled hand's `hand_name`;
- the winner's seat label was the same grey-white as any other text, and was
  not title-cased at render like the board's label;
- nothing announced the result to assistive technology.

## What changed

- `HAND_COMPLETION.ALL_IN_SHOWDOWN_EXTRA_MS = 2000` (both spec copies) and a
  new `allInShowdown` input to `handCompletionHoldMs`, added after the winner
  is announced, on single-board and run-it-multiple hands alike. Not capped by
  `SHOWDOWN_READ_MAX_MS`; never applied to a fold win or a Bad Beat Jackpot.
- "All-in showdown" = two or more hands reached showdown and one of them is an
  all-in player's (an all-in run-out, or an all-in called on the river). The
  engine records it at SHOWDOWN from the live hand
  (`isAllInShowdown` in `presentation/handEventFrames.ts`), sets it for every
  run-it-multiple hand, resets it per deal and passes it to the post-hand hold.
  The client asks the same question of its seats at SHOWDOWN
  (`isAllInShowdown` in `src/lib/showdownPresentation.ts`), passes it to its
  own hold, and holds the beaten hands' muck back by the same two seconds.
- The board band now opens with the winner line (`showdownWinnerLine`):
  "Danimal Wins", "Danimal And Ace Split The Pot", "3 Players Split The Pot",
  on contested single-board showdowns, and is a `role="status"` polite live
  region.
- Every tabled hand names itself at its seat (`shownHandName`, muted), from
  the showdown event, single board only; mucked hands stay private. The
  winner's seat label is gold (`seat__hand-name--winner`) and title-cased.

Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker; the
extra beat is the same for every table and every seat.

## Delivery

The client half (the winner line, the seat names, the gold label, the
client's hold and the muck hold) publishes with the client. The engine's
extra two seconds activate with the next daily engine release at 04:00
America/Chicago: until then the engine's hand-free snapshot still clears the
board on the current timing, so the client's longer hold never shows a board
the engine has already cleared, and nothing deals over anything.

Pinned by `tests/an-all-in-showdown-stays-up-and-names-its-winner.law.test.ts`.
