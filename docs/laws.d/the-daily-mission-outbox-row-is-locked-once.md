# tests/the-daily-mission-outbox-row-is-locked-once.law.test.ts

A drained Daily Missions outbox row is locked once, by the player lock, and
deleted with a plain xid. `enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)`
used to read the row `FOR UPDATE` inside the drain's per-player subtransaction
and delete it inside its own, which gave every drained row a MultiXact xmax: one
MultiXact per booked event, index entries that could never be marked dead, and a
MultiXact lookup on every later read of the row. `fn_lock_daily_mission_user`,
the function's first statement, already serializes every writer of a player's
outbox rows, so the read is a plain read. The law pins the removed fragment and
its replacement, both md5s and the live proof, that the receipt read keeps its
`FOR UPDATE`, that the player lock still precedes the row read, one guarded
transaction, and that the disposable-cluster proof ships with the md5-pinned
live chain. The harness drives one stream through the pre-image and the shipped
migration and proves identical receipts, progress, completion, revisions and
outbox residue; no MultiXact on drained rows and exactly one fewer per event;
no MultiXact lookup when the picker rescans; and four shard drains beside hand
inserts and direct enqueues with no deadlock, no error and nothing lost or
booked twice.
