# Satellite seat counts use integer cents

The award planner divided decimal chip amounts before flooring the funded seat count. Binary rounding makes 0.30 / 0.10 slightly less than three, so a fully funded seat became remainder cash. TournamentManager.processSatelliteAwards calls this planner directly.

Seat division and remainder subtraction now use integer cents after the existing two-decimal normalization. Guaranteed seats still form a floor, and the number of finishers still caps awards. No historical awards or balances are changed.

Regression coverage first failed on the decimal ticket example and an integer-cent conservation matrix. Tests cover exact multiples, one cent below and above a ticket boundary, and short fields.

Separate open findings: satellite target entries still need the shared bounty/prize split, escrow and refund coverage, and complete award-plan recovery verification. The installed seat RPC already rolls back unfunded transfers and missing payout receipts; the old unpublished atomic-seat candidate must not overwrite that newer definition. F30 source delivery remains gated. The full 216-requirement audit is incomplete.
