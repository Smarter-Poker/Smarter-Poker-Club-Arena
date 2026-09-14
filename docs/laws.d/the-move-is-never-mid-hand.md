# server/src/engine/TheMoveIsNeverMidHand.law.test.ts

A must-move / balance / seat-change move happens at a hand boundary and never
inside a hand: a failed read of the pending list may not release a swap hold
(the partner's table lands both chairs, so a released hold is a mid-hand move),
the hold is released wherever the table is rather than only before a deal, a
refused move is told to the player who was promised it, an entry hold never
outlives the deal that made it meaningless, a departed player leaves no
presence behind, the tab-follow packet survives a dropped socket, and only the
pass holding the controller's stall latch may release it.
