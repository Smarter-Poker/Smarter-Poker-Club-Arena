# 2026-10-24 - Transaction History: filters, totals, export and readable rows (client)

Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE". The
client half of the Transaction History follow-ups; the database half
(`fn_cashier_history_page`, `fn_cashier_history_totals`, migration
`20261024213601`) is installed and pinned in the release contract.

- Book chips: owners, co-owners and admins pick All Club Transactions or My
  Transactions; agents pick My Transactions or My Downline. The server decides
  the book and can only narrow it.
- Type chips (All, Cash-Outs, Transfers, Games) and date chips, applied by the
  server, so the list and the totals always describe the same rows.
- My In / My Out / My Net strip from the server totals of the viewer's own
  wallet over the whole filtered book (not just the rows on screen).
- Download These Transactions: a CSV of the filtered book, up to 5,000 rows.
- Cash-out rows read as sentences ("You Accepted X's Cash-Out", "Y Accepted
  Your Cash-Out", "X Cancelled Your Cash-Out").
- The "+1,000RECEIPT" overlap: receipt rows no longer inherit the roster grid;
  they get their own grid and wrap to two lines at 560 px and below.
