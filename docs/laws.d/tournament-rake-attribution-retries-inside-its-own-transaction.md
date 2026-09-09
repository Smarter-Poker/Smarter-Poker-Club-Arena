# tests/tournament-rake-attribution-retries-inside-its-own-transaction.law.test.ts

`fn_settle_tournament_rake` retries the per-player attribution inside its own
transaction on exactly the two transient lock classes (deadlock, lock timeout),
bounded at four attempts and one second of back-off, and stamps
`attributed_at` in the same call. Before 2026-09-09 a deadlock with a live cash
hand left attribution to the repair sweep 435 times a week, 21 minutes late on
average and up to 6.9 hours, during which nobody in the event had VIP points,
commission or a rakeback basis (CLAUDE.md 10.12: retried inside its own
transaction, not swept up later by somebody else).
