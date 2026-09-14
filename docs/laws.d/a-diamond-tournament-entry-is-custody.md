# tests/a-diamond-tournament-entry-is-custody.law.test.ts

A Diamond tournament entry is a custody row, exactly as a Diamond cash seat
is: the registration core reserves settled Diamonds out of the wallet into
`poker_diamond_custody` (purpose `tournament_entry`, ACTIVE from the moment
it is paid, never bound to a seat), an add-on, rebuy or re-entry adds to that
same row through the same lot and journal mechanics, and a refund releases it
whole through `fn_poker_diamond_release` - which now refuses a tournament
entry for anyone but the refund authority, service role included. The custody
rows ARE the event's escrow, and the new append-only ledger
`poker_diamond_tournament_ledger` says how each custody decomposes into prize,
bounty and fee parts, so `fn_ca_tournament_escrow` and `fn_ca_escrow_can_pay`
answer a Diamond event in the chip shape, enforced. This pins migration
`a_diamond_tournament_entry_is_custody`: every chip function it touches is
edited in place behind `fn_ca_tournament_unit_cents = 100` with its md5 pinned
and the reverse substitution proved, so the chip debit, the chip fee rail, the
chip receipt and the chip cancellation body are byte for byte what they were;
a started Diamond event is never voided (the chip rule, kept) and a
cancellation before the start writes the same immutable
`tournament_cancellation_receipts` row the chip estate writes, marked
`asset: diamonds` and proved by a Diamond verifier against the ledger, the
custody rows, the wallet journal and the obligations; the profile wallet guard
admits exactly the two tournament money steps and the arena structure guard
admits a player's own session to exactly the play-state counters; the creation
door is platform-staff-only and refuses every Phase 9 format by name; a horse
is refused by name; and `tournaments_enabled` is never written on.
