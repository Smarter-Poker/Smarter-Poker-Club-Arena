# Preserve the superseded bootstrap's historical proof bytes

The publication shard rejected the historical fixed-board bootstrap after a concurrent change widened its proof from exactly 50 rows to at least 50. The maintained supersession registry already retires this one-shot bootstrap in favor of installed migration 20261016182049. The existing regression pins the original file's immutable SHA256.

Restore only the historical proof comment and its original bytes, matching the last successful published source and the existing immutable-file regression. Keep the supersession disposition, replacement migration, current engine-owned schedule, and #7211's qualified satellite settlement migration unchanged. This is an intentional restoration of historical comments, not a replay or change to the current board. No database or financial operation is submitted.
