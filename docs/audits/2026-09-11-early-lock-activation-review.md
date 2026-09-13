# Phase 3 activation lock ordering

The original approved bundle (SHA256 9e0771e13df999bcf4fc3809865afa53d6b70f2eb947be531c4894dca9e148b0) safely refused production lease locks twice. The second attempt followed the user's explicit approval. Production readback at 08:44:18 UTC retained the Stage A hook ab227471f29f2944ebd64909622b6af7, no satellite scope and zero activation history receipts.

The revised bundle is 276795 bytes, SHA256 579c982a97e9ee356bec57f6b714ce7fa86a517d93e9e7697bd1807b3b07f462. Its three financial component sources are byte-identical. The assembler acquires the same ten canonical public relation locks, in the same order and modes, immediately after the existing realtime.subscription lock and before any component DDL. The later locks remain as component assertions. No NOWAIT, source pin, privilege check, transaction boundary, production time guard or engine release gate is removed or extended.

A native PostgreSQL concurrency proof reproduces the old late-lease inversion: a manager holds RowShare on its lease while waiting for the migration's table lock, so the late lease acquisition refuses. Under the revised exact prefix, an arriving request waits before it can hold that lease. An already-active manager still causes immediate SQLSTATE55P03 refusal. All sessions close and the full native snapshot is unchanged.

The exact revised activation, with the unchanged deployed guard definitions, passed all 138 financial/manager assertions and exact catalog/business/history rollback in a separate owned native cluster. The fixture was copied without role passwords. Its schema was restored before synthetic data to preserve the existing retained fixture's legacy orphan seed rather than alter its baseline. This is isolated test work, not a production restore.

Production remains Stage A. The read-only 09:09:25-09:09:30 observation found no clear sample across the required lock boundary. The revised candidate has NOT been applied. Do not apply automatically or create a migration-history file for an unsuccessful attempt. A genuine quiet interval and all unchanged source/adoption/time gates remain required.

PR4273 merged normally as 66d5e530b174d02fa863f11b8310378b73c2197b after the deployed-schema manifest correction. The user's broad follow-up authorization covers finishing this project, pushing and publishing its completed work, and then pausing. It does not remove the existing production safeguards.
