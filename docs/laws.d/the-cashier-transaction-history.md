# tests/the-cashier-transaction-history.law.test.ts

Dan 2026-10-24: whoever accepts a cash out receives the chips in their own agent wallet and the cashier transaction report shows it that way (each cash-out leg read by the wallet that moved, never crediting the agent a request was merely sent to); the Players heading carries Transaction History instead of the Available and Selected count, every role reads its own history, and only owners, co-owners and admins may switch to All Club Transactions, enforced by fn_cashier_transaction_history.
