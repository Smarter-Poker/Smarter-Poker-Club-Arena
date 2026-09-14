# Run it twice, round three: the client side (2026-09-13)

The client half of the round-three sweep; the engine half is
`2026-09-13-run-it-twice-round-three-engine.md`. Every item below came out of
a line-by-line read of the feature as it stands on `main` eight days after the
per-board ship fix, on the felt and in every hand-history surface.

## The felt

**The frozen pot rows are the gross rows the hand played for.** `state.pots`
is only assigned by the single-board settlement, so a multi-board hand's
snapshot never carries a pot partition and the ship rebuilt its rows from the
award groups, which are NET shares. A 6.76 pot raked to 6.05 read 6.76 all hand
and 6.05 the instant the ship started; a three-way all-in with a side pot froze
as one merged row instead of the main row and the side row the reference holds
up (20.32 / 1.95). `rit_result` already carries the live pots, gross, with each
pot's eligible players; they are recorded at that event, stamped with the hand,
and are what `potShipView` freezes. Pinned in `tests/ritShipsPerBoard.law.test.ts`.

**A silent seat is named.** The engine's expiry now says which one player had
not answered when the clock ran out; the felt strip reads "Running It Once.
Name Did Not Answer In Time." the way it already names a decliner. Two or more
silent seats keep "Not Everyone Agreed In Time."

**A scoop has two rows.** `pot_win.winners_by_board` now carries the low half's
row with `low: true`, and the per-run seat label used to let that row (arriving
second) overwrite the high hand's name with "Low: 8-6-4-3-2". The seat names the
high hand when the player made one, the low only when that is all they won.

## Hand history

**The pot axis is visible.** Every rundown row on a multi-board hand showed
"Board 2" and never which pot the share came out of, because the board label
always won `boardLabel || potLabel` and `winners_by_board` had no pot field to
show anyway. The record now carries per-pot slices (engine half); `buildReplay`
reads them into `ReplayShowdownRow.potSlices`, names them ("Main pot", "Side 1
pot", "Main + Side 1 pots"), and both renderers show "Board 2 · Main + Side 1
pots" when the record has both axes. Older rows are unchanged.

**Share links carry it.** A sixth positional field on the winner tuple,
`index=amount,...`, present only when it says more than "the main pot", so an
ordinary link is byte-identical. Round-tripped in `previousHandPhase4.test.ts`.

**The replayer's seats strip and showdown-frame label read every run.** Both
read board one only, so a player who took run 2 with a flush sat under "Two
Pair" beside a felt drawing both runs. Now "Run 1 Two Pair · Run 2 Flush".

**Legacy boards are read in run order.** The `rit_board_N:` pseudo-action
parser in `handReplay.ts` discarded N and appended boards in log order while
the service's copy of the same parser sorted. One reading, sorted.

**Direct coverage.** `tests/unit/handReplay.test.ts` drove only the legacy
pseudo-action path; the per-board reconstruction was covered only through the
share round trip. It now has a fixture with `winnersByBoard` set directly:
per-board winners, per-board hand names, per-board shares, the pot axis, the
no-slices fallback, and a losing seat on a won board.

## Dead code, removed rather than left as traps

- `RunItTwiceResult` (and its props, `parseRitCard`, the `.rit-board*` and
  `.rit-result*` styles): the 2026-08-18 result overlay. Zero call sites for
  weeks, and it still divided the GROSS pot by the run count - the defect the
  felt's law test pins against. A fully built, plausible component with the
  old bug in it is exactly what the next agent wires up by accident.
- `src/hooks/useHandReplayModel.ts`: zero importers, kept alive only by a law
  pin, and it ran the mapper without the viewer's private cards. The pin now
  asserts the file is gone.

## Stale comments corrected

`handReplay.ts`, `shareHandModel.ts` (two places), `ShareHand.tsx` and
`HandHistoryService.ts` all still said `winners_by_board` amounts are PRE-rake.
The engine has written them post-rake since the 2026-09-04 fix, which
`run-it-multiple-times-tells-the-truth.law.test.ts` pins. Left as they were,
the next reader "fixing" a pre/post-rake mismatch would subtract rake twice.
