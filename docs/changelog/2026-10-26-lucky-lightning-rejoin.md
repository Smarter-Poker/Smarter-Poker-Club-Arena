# Lucky Lightning rejoin

Lucky held a funded PLO4 anchor and an empty PLO5 anchor, while expired Lightning pool sessions retained the seat references. The join RPC answered already seated, and the client treated any returned pool UUID, including a closed session, as an open room. A funded anchor also failed the new-buy-in wallet question when the chips were already on the felt.

The explicit Join Lightning action now resolves the caller's existing seat before opening the amount question. A funded seat enters through the existing pool owner without another debit; an empty seat with no live hand/reservation exits through canonical cashout and its retained receipt before normal purchase. A user lock serializes against buy-in/cashout; authentication, platform freeze, game bar, responsible gaming, joins and live hand ownership remain enforced. Closed room UUIDs are never accepted as an open room by the buy-in helper.

The owner requested 225 chips after removal. Original occupancy cashout receipts returned 202 and zero; an exact once-only 23-chip house-funded settlement completed 225. Readback showed no active seats or open pool sessions. The migration recognizes the existing credit key, preserving any subsequent player activity rather than forcing the balance again.

Validation: focused React/service tests, TypeScript and disposable native PostgreSQL 17 exercise funded reentry without wallet movement, duplicate request, actual pool/slot creation and private event, expired zero-seat canonical receipt, live-hand zero preservation and anonymous refusal. The isolated surrounding freeze/RG/live-hand inputs are synthetic; installed pool/slot owners and repository cashout/session owners execute against PostgreSQL. Production dealing after a player rejoins remains a separate live verification.

## Required-check blocker

The first hosted candidate failed ten existing PLO6 receipt-context refusals in Server Engine shard1. Reproduced all ten locally on the unchanged base. The newer request-priced river admission coexisted with an older broad raise-to-call exception; their OR allowed every invalid context around the narrower owner. Removed only the obsolete broad branch, retaining the existing request-bound river admission and all refusal tests. This is an engine source correction needed to pass protected checks, separately eligible for routine engine activation; the rejoin client/database repair uses existing engine contracts and does not depend on it being activated.
