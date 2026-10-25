# 2026-10-25 - Transaction History: club totals, server search, cursor paging, receipts, one player, waiting cash-outs (client)

Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE" on
the second round. Client half; reads `fn_cashier_history_feed` and
`fn_cashier_history_summary` (migration 20261025025659).

- Club totals: in All Club Transactions, owners, co-owners and admins see
  Entries, Chips Moved and Cash-Outs Paid for the whole filtered club book.
  While earlier days are still being counted the strip says "Adding Up
  Earlier Days..." and asks again.
- Search: a name or an invoice number (CA-2026-...) searches the whole history
  on the server (debounced), not just the rows on screen.
- Load 50 Older Entries reads the next page from the last row on screen (a
  cursor), with no 250-row ceiling; a refresh keeps the older pages already
  read.
- Receipt: a cash-out leg shows its status (Waiting 2h 5m, Accepted,
  Cancelled, Expired) and its invoice number; the copied receipt carries the
  invoice number; the Download adds Invoice and Cash-Out Status columns.
- My Downline: an agent picks one of his players and sees that player's rows
  and In / Out / Net; the whole downline's totals read as one group.
- A cash-out request nobody has decided yet shows "Waiting ..." on its row.
