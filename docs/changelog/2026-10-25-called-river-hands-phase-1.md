# Called river hands, phase 1: the tag, all-in calls, exports, share links

Dan, 2026-10-25, after the first release (`2026-10-25-a-called-river-hand-shows-in-previous-hand.md`):
"show the hand at call down.. do all 6 of these." This is the part that needs no
engine release; the table-side reveal is phase 2.

- **"Called" tag.** `ReplayShowdownRow.calledMuck` is true when a seat was ruled
  mucked at the table and its cards are on record anyway. The hand detail
  (`CALLED`), the table's hand modal (`Called`) and the replayer's seat strip
  (`· Called`) say so, so the hand is not read as one the player chose to show.
- **All-in river calls.** `20261026031500` replaces the door so an `all_in` counts
  as a call when the actor's stack before acting was at most `toCall` on the
  action's own `publicNode`. 5 of 5 such mucks in 6 production hours qualify;
  a raise or an all-in with no snapshot stays private.
- **Tracker export.** A called muck is written "X: mucks hand" at the showdown
  and "Seat N: X mucked [Kh Qc]" in the summary, the PokerStars grammar trackers
  read as a called hand they saw.
- **Shared hand links.** Already carried the cards and the muck; now pinned, and
  the recipient's replay tags the row too.

Pinned by `tests/a-called-river-hand-shows-in-previous-hand.law.test.ts` and
`tests/components/called-hand-tag.test.tsx`.
