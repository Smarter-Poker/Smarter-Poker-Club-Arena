# tests/a-hand-commit-never-takes-the-notify-lock.law.test.ts

Every hand inserts a row into `hand_projection_outbox`, so any trigger on that table that calls `pg_notify` makes every hand commit take Postgres's single cluster-wide notification lock through its WAL flush and commit one at a time; the law replays the migrations in order and refuses if any trigger still attached to the table notifies, and proves it can fail by re-attaching the 2026-09-10 trigger that did this with no listener anywhere.
