# A satellite seat fee reads its charge on the satellite

2026-10-19. Migration `20261019220457_a_satellite_seat_fee_reads_its_charge_on_the_satellite.sql`.

#7472 resumed the owner-direct fee captures saved `legacy_unverified` during the 15:43-19:07 UTC membership move. Between 21:42 and 21:54 UTC it completed and paid 992 stuck tournaments: 714 Spins, 269 SNGs and 9 MTTs.

One decided tournament was left: Union Mystery Bounty (PLO5), `19d8ba17`, decided at 20:19 UTC with its winner unpaid. Its finish refused with `tournament_fee_charge_evidence_mismatch` on its single satellite-seat fee.

The cause was one condition in `fn_accounting_qualify_owner_direct_fee`. It required the charge ledger row's `tournament_id` to be the event's own id. A satellite seat is paid from the satellite's prize liability, so its ledger row names the satellite, which is the entitlement's `source_satellite_id`. The original producer never made that check, and the same function's satellite branch already requires the ledger to come from that satellite. For a satellite seat the condition now reads the satellite; for every other charge it still reads the event.

This was the only one of the 26 still-uncaptured owner-direct batches that was a satellite seat or whose ledger names another tournament.

The fix was proved in a rolled-back production transaction. With it, the engine's own finish completes `19d8ba17`. It pays the 800.00 prize pool across 6 places (282.32 to the winner) with one credit key each, closes escrow at exactly zero and recognizes the 147.50 fee. No wallet is written here, and horses and humans are treated the same.
