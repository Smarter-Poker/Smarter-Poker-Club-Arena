# Cashier Preview Validation

The authenticated Cashier verifier now checks the current validation owner directly. Covered funds have an empty validation status, while an unreadable source wallet says Selected Wallet Could Not Be Verified. It still independently derives coverage from the exact printed funding wallet, rejects unknown amounts, checks the complete status, and verifies Confirm is enabled for covered funds without submitting.

No financial implementation, balance, ledger, or production record changes. The focused funding regression reproduces both stale expectations before the correction.

The actual run 41096180383 passed seven Cashier cases and failed only the ticket option assertion: toHaveValue on the 40 option read the parent select current value, 10. Check the option value attribute instead, then select 40 and continue to require the select value 40 and the two-ticket total 80. The production option itself already carried value 40.
