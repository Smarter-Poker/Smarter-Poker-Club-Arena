# tests/the-unpaid-alarm-reads-every-payout-rail.law.test.ts

The unpaid-tournament alarm counts an event as unpaid only when no rail
delivered value: a chip wallet prize, a Diamond prize on the Diamond tournament
ledger with its journal, or a satellite award. It reads the newest definition of
`fn_tournament_metrics`, the one production runs, so a rewrite that drops a rail
fails, and a new payout rail has to be added to the law's RAILS list and to the
function in the same pull request. It also pins the two commit-time locks that
make the unpaid state impossible to write: MTTs, Spins and Sit & Gos need their
atomic terminal receipt, and satellites need their settlement receipt with a
closed escrow (`satellite_completed_requires_settlement_receipt`, declared in
the money-trigger register). No later migration may drop or disable either
lock, or enable the obsolete batch guard that would refuse every satellite.
Added 2026-10-09 after the alarm paged the owner for 32 Diamond Arena events
that had all paid in full; the same gauge had cried wolf for satellites on
2026-09-12.
