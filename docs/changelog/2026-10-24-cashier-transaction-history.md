# 2026-10-24 - Cashier Transaction History, and the cash-out report reads the wallet that moved

## Dan's instruction

1. "WHO EVER APPROVES THE CASH OUT, THOSE CHIPS ARE CREDITED TO THAT PERSONS
   AGENT WALLET. WHO EVER IS THE PERSON WHO 'APPROVES IT'. AND IT SHOULD BE
   APART OF THE CASHIER TRANSACTION REPORT."
2. "INSIDE THE CASHIER, INSTEAD OF IT SAYING 575 AVAILABLE - 0 SELECTED. THAT
   SHOULD BE THE 'TRANSACTION HISTORY' WHERE AGENTS AND PLAYERS CAN SEE ALL OF
   THERE TRANSACTION HISTORY. BUT OWNERS, CO OWNERS AND ADMINS CAN FILTER
   BETWEEN 'ALL CLUB TRANSACTIONS' AND THERE OWN CLUB TRANSACTIONS."

## What was already right

`fn_cashier_cashout_transition` (the acceptance leg behind
`fn_cashout_approve_v2`) releases the hold into the agent wallet of the person
who accepted it, not the agent the request was assigned to, and books
`chip_transactions.to_user_id` = accepter. Read back on production for
CA-2026-00012497: Golddigger's 20.00 was assigned to DarthBayter, KingFish
accepted it, and KingFish's agent wallet went 240,740.00 -> 240,760.00. The
Full Statement already reports it as KingFish's incoming line.

## What was wrong (the report)

The cashier's Trade Record read every row by its two sides. A cash-out writes
three rows whose sides are not the wallets that moved:

| leg                      | from      | to             | wallet that moved               |
| ------------------------ | --------- | -------------- | ------------------------------- |
| `cashout_request_escrow` | player    | assigned agent | player -> hold                  |
| `cashout_approved`       | player    | accepter       | hold -> accepter's agent wallet |
| `cashout_denied` etc.    | canceller | player         | hold -> player                  |

So the assigned agent was shown receiving every request sent to him (+20 for
DarthBayter, who never got it), the player was counted out twice, and a
canceller was shown paying the refund. `ledgerDirection` in
`src/components/wallet/describeChipTransaction.ts` now reads each cash-out leg
by the wallet that moved, the same rule the Full Statement uses
(`tests/the-statement-counts-each-move-once.db.law.test.ts`), and the legs get
their own sentences, routes and kind words ("Cash-Out Accepted", "Held
Cash-Out To Agent Wallet", "You Accepted Golddigger's Cash-Out Of 20. The Chips
Went To Your Agent Wallet").

## Transaction History

- The Players heading's "N Available · N Selected" is replaced by a
  **Transaction History** button. The selection count still lives in the dock.
- The record tab is renamed **Transaction History**. In the Simple view a
  **Players** button returns to the desk.
- Owners, co-owners and admins get **All Club Transactions / My
  Transactions**. Everyone else reads their own rows.
- New door `fn_cashier_transaction_history(p_club_id, p_scope, p_limit,
p_offset)` (migration `20261024195842`): `club` returns the club's book only
  to owner/co-owner/admin; any other request returns the viewer's own rows, so
  the scope can narrow a book but never widen it. Rows are presented exactly
  as `fn_club_trade_ledger` presents them (arena names, a funded seat as a Club
  Bank send). `fn_club_trade_ledger` is unchanged.
- Probed before shipping as a `pg_temp` copy against production: owner `club`
  251 rows with other members' rows, owner `mine` 0 rows not his, agent `club`
  narrowed to his own rows, player own rows only.

Pinned by `tests/the-cashier-transaction-history.law.test.ts`.
