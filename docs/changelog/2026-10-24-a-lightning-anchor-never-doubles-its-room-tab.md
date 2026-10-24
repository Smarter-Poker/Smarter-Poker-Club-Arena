# A Lightning anchor seat never doubles its room tab (2026-10-24)

Found in the Lightning sweep Dan asked for on 2026-10-24 ("CHECK FOR ANY AND
ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES").

## What was wrong

A Lightning player's chips stay on an anchor seat at a real table, so its
`table_seats` row stays open while they play in the room tab keyed by their
pool-session id. MultiTablePage rebuilds its tabs from open seat rows (on
mount, sign-in and every engine reconnect). It saw the anchor's seat, did not
know the open room tab IS that seat, and added the anchor as another tab.

That tab's TablePage then handed off to the room, found the room tab already
open and closed itself, and the move requested another seat rebuild, which
added the anchor again: an extra tab flickering in and out, and a needless
table mount each time.

## The fix

`src/lightning/lightningAnchorTabs.ts` (`anchorsShownByOpenRooms`): the
rebuild reads each table's `cluster_id` and skips a table whose game's
Lightning room is already open in a tab. With no room tab open the anchor is
kept, because its handoff is how the player gets back into the room.

Pinned by `tests/a-lightning-anchor-never-doubles-its-room-tab.law.test.ts`.
Client only.
