# tests/a-transiently-failed-weekly-close-retries-on-the-next-tick.law.test.ts

Job 272 re-runs a weekly close that failed in the last 3 hours on the next tick when the failure was transient (deadlock, serialization failure, lock wait) or its visit hit the statement timeout, not only after a time-budget failure, so a close never waits an hour for a retry that can no longer reuse its 30 minute report receipt.
