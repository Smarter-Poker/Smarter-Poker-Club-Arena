# tests/a-diamond-tournament-pays-from-its-own-custody.law.test.ts

A Diamond tournament pays from its own custody. The chip estate's one
terminal path (`fn_complete_tournament_terminal` ->
`fn_settle_tournament_places` -> `fn_settle_tournament_obligation` ->
`fn_credit_and_log`, then `fn_settle_tournament_rake`) is kept, and only its
two last steps - where a prize is credited and where the fee goes - are
answered for a Diamond event by draining the event's own custody rows. A
prize is whole Diamonds from the PRIZE parts of the rows, oldest first, into
the winner's wallet as `arena_withdraw` (a move inside the player supply: the
register does not follow it), under the same credit key the chip credit
claims, with the same `tournament_payouts` evidence row, capped by the same
bank. The fee is each player's OWN fee part, out of their own row, journaled
as that player's spend (the register retires it) and minted to the house in
the register, so players + house + custody = register before and after.
Every drained row records a release movement naming its bank, and the entry
guard P0814 (an entry holds exactly its movements) is checked at the end of
each drain rather than at commit, because a row drained twice in one
settlement (the fee, then a prize) would otherwise present its first version
against the final movement sum and refuse the whole terminal - found by
firing the deferred guard at every simulated commit boundary in the
rehearsal. The escrow shadow a Diamond event never had opens at the start of
its terminal settlement, copied from the Diamond ledger with its exact refund
parts, so the terminal writer's exact-zero close and the receipt reader's
checks hold unchanged. This pins migration
`a_diamond_tournament_pays_from_its_own_custody`: every chip function it
touches is edited in place with its md5 pinned and the reverse substitution
proved; the five settlement steps are owner-only (no client role, the service
role included); a bounty is refused by name until Phase 9; and
`tournaments_enabled` is never written on.
