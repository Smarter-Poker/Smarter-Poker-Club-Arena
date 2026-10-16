# Wallet balances and ledger movements use their own formats

The October 16 wallet rule intentionally keeps comma separators and two decimal places below one million. WalletCashierModal shared that formatter with transaction amounts, reversible send history and ledger totals, extending the wallet-only change into those non-wallet values.

The modal now names its balance helper explicitly and uses compactChips for bank/promo ledger movements, in/out/net aggregates and agent claim history. Current/source/recipient wallet balances and before/after wallet snapshots retain exact wallet formatting. The rendered regression covers both ledgers and the claim list beside exact balances; all three cases failed before repair.

The Club Bank Transaction Ledger, filtering, pagination, export ownership, pending-command safeguards, approved Send Out artwork, comma input and exact confirmation amounts remain unchanged. This is display-only: no payment logic, CSS, schema or production financial writes.
