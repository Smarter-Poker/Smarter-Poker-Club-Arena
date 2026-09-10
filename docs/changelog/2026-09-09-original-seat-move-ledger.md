# Original-occupancy cash seat moves and swaps

Status: locally implemented and verified; not deployed. Phase 2 remains in progress.

Read-only production inspection showed moves selecting whichever active seat matched player/table, plus done retries returning only a state refusal. Swap execution also entered differently ordered move/seat locks. New plans capture immutable original occupancy and chair identity. Existing unbound pending plans are cancelled without assigning invented historical identities or moving chips.

Execution requires engine authority, orders shared maintenance, player, game, table and move locks, validates reciprocal swap scope and both original occupancies, then invokes the fingerprint-reviewed movement bodies. A completed transaction verifies the original amount at the destination and original occupancy removal before inserting retained receipts. A single immutable amount produces equal source/debit and destination/credit ledger rows through cash_seat_move_ledger. Receipt failure or unexpected stack mutation rolls back movement, session scope and plan state.

Moves and swaps replay their original committed outcomes after source row, table or plan deletion. Neither receipts nor the derived ledger can be edited directly by application roles. The implementation keeps original sit-out state and the established entry/posting rules; no strategy change was made.

The service validates original scope, amount, destination and receipt identity before reporting completion. A lost response retries only the same immutable move once; unresolved or malformed responses throw. Failed enumeration stays unknown. Engine cleanup and swap holds cannot tear down or hold a replacement occupancy.

Verification: 140 actual PostgreSQL 17 tests passed, with complete migrations applied twice and production physical-chair, pending-player and move foreign-key rules represented. Cases include source rejoin, concurrent duplicate moves, concurrent swap sides, both cashout/move lock orders, invalid amounts, destination corruption, receipt insertion failure, zero-sum ledger, retained receipts, original service retry and replacement-engine cleanup. 28 focused service/read-overlap tests and the full server suite (8,147 passed, database cases run separately) passed. Server TypeScript passed.

Remaining release gates include final unbound alias retirement, combined Phase 2 acceptance and staged schema/client/engine publication through Hetzner. Distributed restart and event-delivery durability remain part of Phase 3; this does not claim those gates completed.
