# Phase 1 audit, part 3 — the bound and the rings are one number now

2026-08-31. A trap I planted in #2068 while fixing the loop, found by asking
what happens at the edge of my own new constant.

## The defect

`heroSeatReconcile.ts` declared its own literal:

    export const MAX_SUPPORTED_SEATS = 10;   // "one seat of headroom"

`SEAT_LAYOUTS` in `tableSeatGeometry.ts` defines rings for 2 through **9**, and
`seatLayoutFor()` clamped to 9. So a table reporting ten seats would have grown
**ten rows of state against nine drawable positions** — seat 10 existing in
`players[]` and rendering nowhere.

That is precisely the bug this whole phase exists to kill, reintroduced one
layer up, by the fix for it, in the form of a number copied out of its source.
It is not reachable today (the largest table in the estate is 9-max, and no
`max_players` outside {2,3,6,7,8,9} exists), which is exactly why it would have
waited quietly for whoever adds a 10-max table.

## The repair

One number, derived from the rings themselves:

    export const MAX_SUPPORTED_SEATS =
      Object.keys(SEAT_LAYOUTS).reduce((max, k) => Math.max(max, Number(k)), 2);

`heroSeatReconcile` re-exports it rather than declaring its own, and
`seatLayoutFor` clamps to it instead of a hardcoded 9. Adding a `10:` layout now
raises the bound and everything reading it in the same edit — the two values
cannot drift, because there is only one.

Pinned by a new case in `heroSeatReconcile.test.ts` which asserts the bound
equals the largest ring AND that the largest seat the reconciler accepts has a
position to be drawn on. Verified real: restoring the `= 10` literal turns it
red.

## Verification

- Full client tree: **701 files, 9,950 tests, 0 failures**.
- `tsc --noEmit` clean.

---

## And a third payload the seat count was missing from

Same audit, found by asking where else a client can receive state. Phase 1 put
`max_seats` on the two hub payloads — `broadcastCurrentState` and
`publishIdleState` — and stopped there. There is a THIRD:

`getTableState()` answers `GET /state/:id`, which `TableWebSocket.resync()`
fetches on a websocket **sequence gap** and dispatches to the page as
`GAME_START`, the full-state resync. So the one payload without the seat count
was the one a client asks for after losing frames — precisely the client whose
local view is most likely to be wrong.

Worse, the fallback there is inference from the response's `players`, and that
list is the HAND roster: it omits anybody not dealt in, including a player
waiting for the big blind. The inference can therefore land BELOW the truth.
That is the original bug's exact starting position, reached through the
recovery path.

Fixed, from the same source as the other two (the table row, never the roster),
and `SeatCountIsPublished.test.ts` now requires all three payloads. Verified
real: removing the field turns two pins red.
