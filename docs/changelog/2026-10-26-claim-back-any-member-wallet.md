# Claim Back From Any Member Wallet

Management Claim Back now offers Player Wallet, Agent Wallet and Promo Wallet on the existing selected-member card. The selected wallet's authorized RPC balance drives its displayed amount, Claim All, validation and the source in both durable operation reservation and fn_club_bank_claim_back. Switching wallets clears the amount; unread or absent balances remain unavailable and cannot be claimed. Balance read errors offer Retry. Late responses from a prior member, club or closed dialog are discarded.

The installed database already supports all three sources, atomic holder debit/bank credit, scope checks, traceable history and exact-intent replay. This change uses that contract without a migration or engine release. Ordinary agents retain their existing ten-minute send reversal.

Regression coverage mounts the real CashierTradePage and checks all three wallet sources, selected-wallet limits, zero/missing balances, delayed/failed reads and retry. All six added cases fail against the pre-fix page. Live database function definitions were inspected read-only; no production chips were moved for testing.
