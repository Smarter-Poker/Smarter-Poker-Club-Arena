# A late snapshot of a settled hand is not written (2026-10-06)

## What happened

"1 Chip Deep Stack Spin NLH" (a1a6cfea, table 2340864c, two seats holding
1,094 and 1,906) dealt its last hand at 06:11:14 UTC and then stood still for
two hours, including through the 07:55 engine restart that recovered the two
large events frozen by the same database stall.

Rows read at 08:05: hand 25606036 was settled at 06:11:14.05 (history row,
atomic commit, permit `accepted`). At 06:11:20.13 an in-progress snapshot of
that same hand was written with `is_complete = false`: the engine's own
earlier flush, delayed six seconds by the stall, landing after the settlement
had completed the hand's snapshot. Every admission of the table was then
refused `F06_CONTINUATION_STARTED_OR_ROSTER_CHANGED`, because an incomplete
snapshot reads as a hand in the air. It was the only such row in the database.

## The cause

`save_hand_state_snapshot` wrote whatever it was handed and never asked whether
the hand was already settled. A delayed request re-opened a finished hand; had
the table started its next hand, the one-active-row upsert would have
overwritten that hand's live snapshot instead.

## The fix

Migration `20261006081157`:

- the writer returns without writing when the hand is at or below the table's
  newest atomic commit;
- the writer and `acknowledge_hand_submission` take one per-table transaction
  advisory lock, so the check and the completion cannot interleave;
- the one re-opened snapshot is removed. No chip moves; the hand's history and
  commit rows are untouched.

## Proof

On a PostgreSQL 16 scratch database holding byte-identical copies of both
functions (md5 equal to production): the migration applies and re-applies as a
no-op; a late save of a settled hand writes nothing and leaves the next hand's
live snapshot alone; ordinary saves are unchanged; a late save issued during an
open settlement transaction waits for it and then writes nothing.
`tests/unit/aLateSnapshotOfASettledHandIsNotWritten.test.ts` pins the text.
