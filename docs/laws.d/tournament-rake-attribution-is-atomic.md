# Tournament rake settles with its player attribution

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
