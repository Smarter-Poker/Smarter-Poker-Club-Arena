# Cashier Send Out: No Extra Balance Strip Between The Frames

Dan, 2026-10-17: "REMOVE THE EXTRA WALLET BALANCES BETWEEN THE PLAYER FRAME AND THE
"FROM YOUR AGENT WALLET" FRAME. THE BALANCE SHOULD ONLY SHOW ONCE IN EACH FRAME.
KEEP THE CLUB BANK TRANSACTION LEDGER."

The Send Out panel in Cashier and Club Bank printed a third row, "Agent Wallet: N
Player Wallet: N", between the selected player frame and the funding frame. That row
(`Selected Player Wallet Balances`, `.recipientWalletSummary`) is removed. Each frame
now prints its own balance once on its face; every wallet balance is still listed in
the frame's selector options, so no balance became unreadable.

The Club Bank Transaction Ledger, transfer handlers, recovery guards and amount
formatting are untouched.

Validation: `tests/unit/cashier-trade-launch-audit.test.tsx` now asserts the strip is
absent and that both recipient balances remain in the selector options; TypeScript
and the normal protected delivery checks.
