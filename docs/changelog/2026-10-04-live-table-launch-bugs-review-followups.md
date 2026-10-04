# Review follow-ups to the ten live-table fixes (2026-10-04)

A line-by-line review of #6064 and #6092 after they shipped. One finding was
serious and was live; the rest are edges.

## The serious one

`breakHidesCards` (item 7, "no cards during the break") treated
`currentPlayerSeat === 0` as "this table is parked". The seat is 0 between
every two actions, through every all-in runout and for the whole result hold,
and the engine starts the break countdown at :55 whether or not a table's last
hand has finished. So a hand still running at :55 had the hero's hole cards
blink off between actions and tabled hands turned face-down under the winner.
The break now hides a card only on a felt with no chips in the middle, no
board and no winner on show; the ordinary case (the page watched the hand
end) never depended on it.

## The rest

- A finished hand left a fan of card backs on every opponent and the hero's
  hand label under the plate; both now leave with the cards.
- A late or replayed `hand_complete` for another hand can no longer mark the
  live hand finished (the event's `hand_number` is checked against the felt).
- All-in win percentages were misplaced in tile view (a scaled ancestor) and
  were not re-measured when hands were tabled or the felt resized.
- The socket banner ("Connection Lost...") had the same half-width clipping
  that was fixed in the seat line; fixed the same way.
- The turn ring's final-seconds pulse held its flared frame all turn; the
  `@supports` gate now tests the construct it guards; a turn with no start
  stamp takes its length from the deadline.
- The tournament dock keeps its frame while its row loads, and its collapse
  toggle is one value for every open table.
- An ALL IN press no longer switches the client into all-in mode or counts a
  preflop raise by itself; the engine's echo does.
- Horses: a whole-stack raise promoted to all-in is not turned into a call,
  and the ledger records what the engine executed.
- Release control: a routine release no longer takes the engine lock to ask
  for a window the seal always refuses.
- Quick Join / lobby: the tournament landing is one-shot, a failed read is not
  shown as an empty list, the chunk import is inside the timeout, a table read
  as cash is cash, and a move is announced per move rather than per
  destination.
