# tests/the-chip-legs-refuse-a-diamond-row.law.test.ts

Dan's ruling 16 says the Diamond Arena has no unions, no agents, no
commissions, no chip wallets and no chip ledgers. The arena was built on the
chip estate, though, and several chip "legs" would still count a Diamond,
bill one or refuse one. Step 0 of the destinations design
(docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md, section 4) is the set of
fences that needed no decision, and this law holds them in place.

The chip supply meter (fn_ca_supply_snapshot, a watched guard) no longer
counts a Diamond seat, a Diamond pending add-on or a Diamond event's pools as
chips. Without that, the first busy hour of Diamond play would have looked
like unexplained chip supply and paged as a chip leak. The two chip
guarantee triggers now refuse a Diamond event by name
(diamond_guarantee_has_no_chip_bank, diamond_overlay_has_no_chip_bank)
instead of reaching into the arena's chip treasury. The Diamond creation door
now refuses by name (diamond_tournament_money_key_not_read) the six money keys
the estate's builder sends but the door never reads. Before, a value in one of
them was silently dropped and the event was created without it. The door
still admits each key's default.

The accepted-hand door now admits every game the arena deals, using the same
rule as the settler and the admission door (fn_poker_diamond_cash_variant),
where before it refused every Diamond hand that was not hold'em. The rehearsal
also found that no Diamond cash hand could commit at all, hold'em included,
because the chip provenance receipt demanded a chip settlement claim that the
Diamond settler never writes. So a Diamond hand now writes no chip provenance
receipt and no union P&L cash outcome. Its own settler receipts it.

Ten chip money tables now refuse a Diamond Arena row by name ("Diamond Arena
Has No Chip Money"), the same way poker_arena_no_hierarchy refuses an agent
row: chip_ledger, rake_records, rake_attributions, bbj_contributions,
bbj_pools, club_wallets, tournament_tickets, tournament_guarantee_overlays,
and the two tables behind accounting_payable_earning_sources. A row counts as
the arena's if its club, its table or its event (for a ticket, its source
event) belongs to the arena. Each fence runs first on its table and is
declared in the same migration. Before the fences went up, the migration
proved that no such row existed. tournament_rake_settlements is left
unfenced, because the Diamond fee path still writes to it until step 3 moves
that path.

Every chip function is changed in place, with its live md5 pinned and the
reverse substitution proved. Neither migration opens a switch or sets a
price.
