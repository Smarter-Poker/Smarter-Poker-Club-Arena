# tests/a-window-migration-waits-for-the-daily-break.law.test.ts

A migration declaring "-- @install-window: daily-maintenance" is refused as queued by the ordinary applier and installed only by the daily 03:30 America/Chicago run of stage-engine-release.yml inside the confirmed 04:00 freeze: one transaction and one attempt per file, the break-window override reason recorded by the existing DDL guard, 1 s lock_timeout, 5 s statements and an 8 s budget asserted before COMMIT, no sleeps, blocking advisory locks or LOCK TABLE loops, and the first refusal stops the run with the rest still queued.
