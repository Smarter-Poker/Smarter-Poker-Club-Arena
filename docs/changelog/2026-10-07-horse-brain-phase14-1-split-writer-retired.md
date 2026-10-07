# Horse Brain Phase 14.1 cutover: the split hand-review rollup writer is retired (2026-10-07)

The engine build carrying the single-call writer (`fn_hhr_record_atomic`,
#6352) is serving. From 10:01Z to 10:30Z it wrote 782 hand reviews, and
every one has its receipt and its rollup row; none is missing. No installed
function and no engine source calls the old `fn_hhr_rollup_add`.

Migration `20261007103144_retire_the_split_horse_hand_review_rollup_writer.sql`
revokes `service_role`'s EXECUTE on `fn_hhr_rollup_add`. The function stays
installed and unchanged, and no table, row or aggregate is touched. The
migration refuses to apply unless the atomic function exists and has
already written receipts. Its ACL is pinned before and after the revoke, so
it cannot run twice or ahead of the atomic path. Historical rows written by
the old writer keep their unknown rollup status.

Verified on PostgreSQL 17 against the P14.1 fixture: refused before any
receipt; applied after one; `service_role` is denied the old function and
still runs the atomic one; a second apply is refused.
