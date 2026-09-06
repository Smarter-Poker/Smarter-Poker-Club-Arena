# tests/aClosedTableOwnsNoMainIndex.law.test.ts

A closed or soft-deleted cluster table owns no `main_index`, and the trigger that enforces it watches all four columns whose write can break it (`lifecycle, is_deleted, main_index, cluster_id`) - the two-column form was blind to a renumber and let 2,935 closed tables be stamped on 2026-09-05; the migration's repair is an UPDATE to NULL, never a DELETE, and its DDL stays in its own transaction taking ACCESS EXCLUSIVE first under a `lock_timeout` because the combined form deadlocked against the cluster tick.
