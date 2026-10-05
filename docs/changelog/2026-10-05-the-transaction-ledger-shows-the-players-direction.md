# The transaction ledger shows the player's direction

The live history screen displayed tournament buy-ins as incoming chips. The
stored chip transaction records a positive movement and the player as sender;
the page treated that unsigned amount as a credit. It also omitted the minus
sign when rendering an already negative legacy amount.

The page now derives personal wallet change from the transaction endpoints,
including the reversed direction of claim-back records. Bank operators are
actors rather than personal recipients of bank funds. Internal wallet moves
retain their full displayed movement while contributing zero to personal net
flow. CSV exports include the movement and a separate personal-wallet change.
The session cache version changes so old incorrectly signed summaries cannot
flash on a revisit. Database read errors now reach the existing error message.

A rendered-page regression reproduced +10 instead of -10 before the fix and
passes afterward. Pure cases cover buy-in, cashout, both transfer directions,
self-stakes, agent claim-back, bank sends/claims/reversals, legacy signed amounts
and invalid values. Existing first-page refresh coverage remains intact.

This changes presentation and export only. No stored balance, transaction,
rake rule, fee, or payout is rewritten.
