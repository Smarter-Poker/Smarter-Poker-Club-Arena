# 2026-10-25 - Transaction History: club totals, server search, cursor paging, receipts, one player, waiting cash-outs (database)

Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE" on
the second round of Transaction History improvements. Database half; the
client follows once this is installed.

- `fn_cashier_history_feed`: the book (club / downline / own) is decided once
  by `fn_cashier_history_book` and only narrows; `p_person` narrows it to one
  member of the book; `p_search` is an exact invoice number or part of a
  member's arena name; paging is a `(created_at, id)` cursor; every cash-out
  leg carries its request status and invoice number.
- `fn_cashier_history_summary`: one wallet's In / Out / Net (viewer or picked
  person), a downline's In / Out / Net as one group, or the whole club's
  Entries, Chips Moved and Cash-Outs Paid.
- `cashier_club_day_totals`: per club, per closed UTC day, per type. The ledger
  is append-only, so a closed day is counted once, by the first request that
  needs it (2.5 s budget per request, `complete=false` until done). No
  schedule, no ledger trigger.

Measured on production (KINGS CLUB, ~983k rows) with the same definitions in
`pg_temp`, rolled back: club page 1 17 ms, cursor page 2 88 ms, a deep
Transfers page 187 ms, invoice search 8 ms, name search 302 ms, one person
9 ms; club 7-day totals 2.7 s on the first call (cache filling), 0.9 s
complete on the second, matching a direct count to the row.
