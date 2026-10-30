# Cashier Preview Validation

The authenticated Cashier verifier now checks the current validation owner directly. Covered funds have an empty validation status, while an unreadable source wallet says Selected Wallet Could Not Be Verified. It still independently derives coverage from the exact printed funding wallet, rejects unknown amounts, checks the complete status, and verifies Confirm is enabled for covered funds without submitting.

No financial implementation, balance, ledger, or production record changes. The focused funding regression reproduces both stale expectations before the correction.
