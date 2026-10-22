# tests/a-migration-never-holds-the-live-tables-hostage.law.test.ts

A direct database session (a migration, the MCP, psql) whose transaction is older than 15 seconds is cancelled within 5 seconds if it queues or holds a writer-blocking lock on a public table while live requests wait behind it; PostgREST traffic is never a target, every cancel is recorded in ca_writer_lock_sentinel_cancels and raised as a warning, and no migration after 2026-10-22 may retry LOCK TABLE in a loop.
