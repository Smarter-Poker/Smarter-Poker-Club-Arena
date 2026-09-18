# server/src/services/theFleetReportsWhatItCannotFinish.law.test.ts

Tests: `server/src/services/theFleetReportsWhatItCannotFinish.law.test.ts`.

The scrape says how many RUNNING tournaments are already decided and not
finished, how old the oldest is, how many horses sit in those games, how many
tournaments an unreconciled entry fee blocks, how many backends wait on each
settlement lane, and how many deadlocks the database has detected. All of it
comes from one read a minute of `fn_ca_horse_fleet_metrics`; a failed read
keeps the last good snapshot and `poker_horse_fleet_metrics_stale_seconds`
says how old it is, so a broken collector is visible as a broken collector and
never as a healthy platform. A refused finish is counted under a bounded
reason label, never under its message.

Eight cases. Written 2026-09-17, phase 3 of the horse programme, the day 547
of 835 running tournaments were decided and unfinished and the scrape said
nothing.
