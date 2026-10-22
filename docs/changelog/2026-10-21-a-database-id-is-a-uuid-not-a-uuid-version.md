# A database id is a uuid, not a uuid version

Union Bank pull back still failed after the directory fix (#7621): selecting KINGS CLUB and pressing Pull showed "Invalid Union Wallet Intent" and sent nothing.

Cause: `UnionWalletRecovery` validated the union id with a regex that pins the RFC version and variant nibbles (`[1-5][0-9a-f]{3}-[89ab]`). The Midway Union's id is `fade0000-0000-0000-0000-000000000001`, a valid Postgres uuid with version nibble 0, so every Union Bank movement was refused in the browser before reaching the server. The tests used v4 fixtures, so they never saw it.

The same mistake sat in three more places that validate database ids:

- `AgentWalletIntent`: every agent wallet transfer in The Felt Society (`a0000000-0000-0000-0000-000000000001`) and every transfer to a horse (`00000000-...-0000000000NN`) was refused with "The Transfer Account Could Not Be Verified".
- `CashierPendingOperations`: a Felt Society route id was treated as a slug and re-resolved.
- `ClubJoinService`: a join link carrying a non-v4 club id was not recognized as an id.

All four now use `src/utils/entityId.ts` (any 8-4-4-4-12 hex value, never the nil uuid), the same rule the cashier recovery code already used. Ids the client generates for itself (operation and request ids) keep their strict check. The SQL side was already governed by `a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts`; `a-database-id-is-a-uuid-not-a-uuid-version.law.test.ts` is its client twin and uses the real production ids.

No server, database or money RPC change: the server functions take `uuid` parameters and always accepted these ids.
