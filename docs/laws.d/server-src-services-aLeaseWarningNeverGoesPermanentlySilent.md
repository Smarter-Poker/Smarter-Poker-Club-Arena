# server/src/services/aLeaseWarningNeverGoesPermanentlySilent.law.test.ts

Every lease warning in `tableLease.ts` and `tournamentLease.ts` was written as
`if (xErrors <= 3)`, and those counters only ever increment, so after the third
occurrence in a process lifetime the path was silent for the life of that
process. The cap had a real reason - a failing heartbeat recurs every five
seconds and would drown the log - but "quiet" and "silent" were collapsed into
one thing.

It cost a night. On 2026-09-12 the ownership lease renewal loop stopped and every
cash table was killed by its own twenty second proof watchdog and re-claimed,
26,129 times in 2h10m, with 1,483 hands abandoned mid-play at tables holding nine
of nine seats. The container log carried not one `[lease]` line across the whole
run. That happened to be because the heartbeat was never called at all, but the
log could not have distinguished that from "failing every five seconds since the
third attempt", and the evidence had to be checked another way to find out which.

The flood protection is kept and the permanence dropped: the first three print,
then at most one a minute carrying how many were held back since the last. The
law pins that a recurring failure still speaks on the thousandth occurrence
eighty-three minutes in, that a noisy reason cannot silence a different one, and
that no `Errors <= N` cap survives in either lease path - which is how it caught
a fifth capped warning in the claim path that the first pass missed.
