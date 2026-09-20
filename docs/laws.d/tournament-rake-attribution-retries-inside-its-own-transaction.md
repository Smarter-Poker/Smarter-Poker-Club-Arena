# tests/tournament-rake-attribution-retries-inside-its-own-transaction.law.test.ts

`fn_settle_tournament_rake` retries the per-player attribution inside its own
transaction on exactly the two transient lock classes (deadlock, lock timeout),
bounded at four attempts and one second of back-off, and stamps
`attributed_at` in the same call. Before 2026-09-09 a deadlock with a live cash
hand left attribution to the repair sweep 435 times a week, 21 minutes late on
average and up to 6.9 hours, during which nobody in the event had VIP points,
commission or a rakeback basis (CLAUDE.md 10.12: retried inside its own
transaction, not swept up later by somebody else).

## Tournament rake settles with its player attribution

Under CLAUDE.md10.11/10.12, a new rake settlement must credit its fee and
attribute its players in the same transaction. A transient lock failure may
retry within that transaction using the existing four-attempt budget.
Exhaustion, a permanent exception or an incomplete result must roll back the
fee, counters and claim. A later repair is not the live settlement path.

A historical claim with incomplete attribution is refused without rewriting
history or crediting it again. Successful replay returns stored attribution
proof. Existing zero-member, zero-fee and Diamond rules remain unchanged.

The source law is pinned by
`tests/tournament-rake-attribution-retries-inside-its-own-transaction.law.test.ts`.
The native behavioral gate is `npm run test:db:rake-attribution-atomic --
--output <new-evidence-directory>`, using PostgreSQL17 in the existing hosted
accounting_postgres job with `PG_BIN=/usr/lib/postgresql/17/bin`. Its financial recorders establish transaction control; they do
not certify the complete financial dependency graph or a production release.
