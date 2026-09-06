# The half fence, and a backstop that could erase a live board (2026-09-06)

A review pass over yesterday's ten-defect batch (`964007eb6`, changelog
`2026-09-05-ten-mobile-defects-from-the-felt.md`), after Dan asked for a
line-by-line check for bugs, gaps, stubs and regressions before calling it done.

Nine findings. Two of them are worse than the bugs they were introduced to fix,
and both are mine.

---

## 1. The stuck-banner backstop could blank a LIVE board and zero the POT

The backstop added yesterday preferred the stored end-of-hand reset closure,
`handCompleteResetFnRef.current`, "so the board, pot, mucks and stack hold come
down together".

**Nothing on the normal path ever nulls that ref.** The reset closure nulls the
TIMER (`handCompleteTimerRef`), not itself, and the only other writer is the
next `HAND_COMPLETE`. So the ref almost always holds the PREVIOUS hand's reset -
and in the exact scenario the backstop exists for (a late `pot_win` arriving
after `HAND_STARTED` for the next hand) running it would have

- emptied `communityCards`, `communityCards2`, `communityCards3`,
- forced `boardStage` and `engineStage` back to `preflop`,
- set `pot: 0` and cleared `sidePots`,

on a hand being played, until the next engine broadcast repainted it.

A backstop for a stuck LABEL must never be able to erase a live board. It now
clears exactly what it is about - `winnerInfo` and the winner particle - and
touches nothing that belongs to the hand. Pinned in
`tests/unit/handCompletionLaw.test.ts`: the block may not contain
`handCompleteResetFnRef`, `setTableState`, `communityCards`, `boardStage` or
`setRitResult`, read with the prose stripped.

**And it was missing the third clock.** It waived itself while
`handCompleteTimerRef` or `potAwardAnimEndAtRef` was live, but not
`ritRevealEndsAtRef` - the longest of the three, past twenty seconds on a
three-run reveal at a slow animation speed, and the only one a client that
missed `HAND_COMPLETE` has. That client is precisely the one the backstop is
for, so the animation-law violation it promised it could not commit was
reachable. All three clocks now waive it.

## 2. The hand fence was half a fence

Yesterday's `winnerBandActive` fenced the board band's TEXT. It did not fence:

- the board-1 card highlight (`highlightedIndices`),
- the board-2 and board-3 highlight memos,
- the felt-wide `table-page--winner-flash`,
- the pot award total,
- the seat's `isWinner`, `winningHandName` and `winningHoleCardIndexes`.

So a stale `pot_win` still lit the live board's winning five, still dimmed every
other face-up card, still flashed the felt and still popped a seat - with the
sentence above them correctly silent. That is Dan's 2026-08-27 complaint ("cards
dim like you folded, even though you are live in a hand") with the label
removed: half a fence is a bug with extra steps.

One const, declared above the derivations that consume it, read by every winner
surface including the seat guard that used to write the same expression out a
second time. Two copies of one rule is how the board kept lighting up after the
seats had gone quiet.

## 3. LOBBY opened a modal that could not be closed, in tile view

The new button lives in the fixed action strip, which is NOT scaled and IS
clickable in tile view. The lobby it opens is a child of the `.table-page` root,
which tile view renders at `scale(0.5)` with `pointer-events: none`. Tapping it
produced a half-size modal inside one tile that could not be scrolled, clicked,
or closed except by Escape. Every previous opener lived inside that same dead
subtree, so it was unreachable rather than broken; this one made it reachable.
The button (and the 4-square's shift, and the strip's reserved band) is hidden
in tile view.

## 4. A must-move move made the button disappear at the worst moment

`updateTableInfo`'s in-place tab re-point rebuilds the `TableInstance` from a
literal that omitted `clusterId` - so the LOBBY button vanished and the 4-square
jumped sideways at the exact instant a must-move, seat change or balance move
relocated the player, until the remounted TablePage reported the cluster again.
The game does not change when the table does; the cluster is carried forward.

## 5. Join Game could succeed in silence

`onClose(); onGoToTable?.(...)` said nothing. Two real paths ended with the
player told nothing at all: a surface that passes no `onGoToTable`, and a door
that seats you at the table you are already viewing (TablePage's handler returns
early on `dest === tableId`). The seat is reserved server-side either way. It
names the table now. A non-throwing refusal (`{ok:false}` with no table and no
waitlist place) was also swallowed; it speaks too.

## 6. The footer could still strand, and its reveal missed by half a pixel

- The `MIN_SCROLLER_RANGE` early return sat above both reveals, so a scroller
  that shrank below the floor WHILE the bar was hidden (a filter collapsing a
  list, images unloading, a soft keyboard cutting `clientHeight`) left it hidden
  with no way back but a route change. It reveals and drops the travel entry.
- `y >= limit` compares a fractional `scrollY` against an integer
  `scrollHeight`, so on a fractional-DPR or zoomed phone the true bottom is
  `limit - 0.5` and the end-of-page reveal never fired - on exactly the class of
  device it was written for. One pixel of tolerance.

## 7. The buy-in sheet overflowed a short viewport

The vertical track's fixed 168px was measured against 375x812. On a 375-tall
landscape phone the sheet has no `max-height` and the overlay does not scroll,
so BUY CHIPS went off-screen and unreachable. The track is the one element that
can shrink without losing meaning, so it is the one that does:
`clamp(96px, 26dvh, 168px)`.

## 8. The bomb marker could sit on the pot total on a ONE-board bomb

`bombPotActive` is true for a boardCount of 1, and nothing enforced the comment's
assumption that the label only appears on a multi-board stack. On one board the
community sits at `top: 42.5%` and its top edge lands in the same band as
`.pot-area` (`top: 32.99%`). Below the stack is free on exactly that hand - the
scoop banner anchored there appears only on multi-board hands - so a single-board
bomb hangs the marker the other way. The two can now never contend, on any board
count.

## 9. The announce window was being talked over

`bombClockLabel` returns null for two different reasons: no timed bomb at all,
or a timed bomb whose host-set announce window has not opened
(`bomb_pot_announce_seconds`). The ladder treated them the same and fell through
to the hand-count branch, so a host who asked for quiet got a PULSING masthead
line. Harmless as a transient felt pill; not as a permanent masthead row.

---

Also: the stale `.bomb-pot-eta--live` reference left in TablePage's own comment
(SeatSlot's copy was updated, this one was not), a guard so the bus event cannot
open a lobby with no cluster to read, and the LOBBY/4-square geometry moved from
a literal `62px` shift against a `min-width` button - a 0-4px gap that closed to
an overlap under a reader's font scale - to three custom properties declared
once.
