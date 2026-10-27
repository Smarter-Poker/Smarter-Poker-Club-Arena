# Reclaim Return Wallets And Chip Movement History

Owner request: choose the return wallet when reclaiming chips, preserve promo funds, simplify the transaction history, default to Today and latest transactions, and remove Managed.

Reclaim now carries an explicit destination through the durable browser intent, database transaction and receipt. Staff can choose their own eligible wallets or the club bank/promo wallets. Agents retain the original-send, remaining-amount, downline and ten-minute restrictions and can choose their own return wallet. Promo may return only to the claimant's promo wallet or, for staff, club promo. Existing public reclaim entry points also preserve promo when called by an older client. Cash claims preserve proportional repayment of the original credit draw; the receipt separates returned funds and credit repayment. Each direct movement has one journal leg, with a separate leg for any credit repayment, in the same transaction as both balances and the original-send flags.

History uses framed filters, totals, search and receipts; it opens on Today, Chip Movements and Latest Transactions. Games and the unexplained Managed filter are removed. Owners, co-owners and admins retain club/self scope; agents default to their own/downline scope, enforced by the database. The authoritative feed and totals exclude game/buy-in types, even for a legacy All request, so paging and CSV exports share that restriction. Ticket redemption is game admission and is excluded; ticket issuance and cancellation remain wallet movements. Historic rows are preserved.

Validation and delivery evidence are maintained in CHECKPOINT-cashier-reclaim-history.md. This file does not assert installation or publication.

Promo wallet follow-up: scope the balance read to the viewer role, matching the open/reset effect. A role update previously cleared both promo accounts without issuing a replacement read. A real-dialog regression fails with Unavailable before the fix and passes with club promo 3,000 and personal promo 0 after it.

Installation procedure correction: migration 20261027160320 was mistakenly applied before protected merge. No outage exception existed. The recorded-migrations manifest now preserves the byte-exact installed history (md5 c5118da8bac3d29e8790f59ce7eb6179); it must not be replayed.

Owner follow-up: every agent tier can reclaim from their own player or agent wallet at any time. Both cashier entry points offer Claim From My Wallets. Another member still requires the original recent send, while club return authority and promo-only restrictions remain. Separate protected-main migration 20261027164937 changes only the self-claim authority predicate; it is not installed before merge. Native before-fix self-claim failed with Choose One Of Your Recent Sends; native and real-dialog regressions cover all three agent tiers.
