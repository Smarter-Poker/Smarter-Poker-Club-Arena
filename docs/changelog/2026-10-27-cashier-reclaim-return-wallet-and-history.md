# Reclaim Return Wallets And Chip Movement History

Owner request: choose the return wallet when reclaiming chips, preserve promo funds, simplify the transaction history, default to Today and latest transactions, and remove Managed.

Reclaim now carries an explicit destination through the durable browser intent, database transaction and receipt. Staff can choose their own eligible wallets or the club bank/promo wallets. Agents retain the original-send, remaining-amount, downline and ten-minute restrictions and can choose their own return wallet. Promo may return only to the claimant's promo wallet or, for staff, club promo. Existing public reclaim entry points also preserve promo when called by an older client. Cash claims preserve proportional repayment of the original credit draw; the receipt separates returned funds and credit repayment. Each direct movement has one journal leg, with a separate leg for any credit repayment, in the same transaction as both balances and the original-send flags.

History uses framed filters, totals, search and receipts; it opens on Today, Chip Movements and Latest Transactions. Games and the unexplained Managed filter are removed. Owners, co-owners and admins retain club/self scope; agents default to their own/downline scope, enforced by the database. The authoritative feed and totals exclude game/buy-in types, even for a legacy All request, so paging and CSV exports share that restriction. Ticket redemption is game admission and is excluded; ticket issuance and cancellation remain wallet movements. Historic rows are preserved.

Validation and delivery evidence are maintained in CHECKPOINT-cashier-reclaim-history.md. This file does not assert installation or publication.
