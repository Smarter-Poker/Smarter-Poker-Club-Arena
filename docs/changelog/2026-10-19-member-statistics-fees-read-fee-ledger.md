# Player Statistics fees match the member record

Player Statistics summed per-hand rake from the first recorded hand. Player Management and the member record read the fee ledger, which counts from the fixed fee counting start (Monday 2026-10-12) and includes tournament fees. The same member showed two Fees figures (for one Club JAQK member, 7,995.69 against 4,340.78).

For all games, `ca_club_member_statistics` now returns the exact `ca_club_member_fee_totals` total the member record reads, for the same club, member and dates. A single game has no ledger split, so it sums that game's rake from the same counting start. Hands, net and every rate are unchanged; no money is written.
