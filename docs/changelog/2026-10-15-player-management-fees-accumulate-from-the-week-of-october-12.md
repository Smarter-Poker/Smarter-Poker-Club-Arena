# Player Management Fees Accumulate From The Week Of October 12

Dan corrected the weekly reset the same morning: fees should not fall back to
zero every Monday. They count from one fixed start, Monday October 12, 2026
(midnight Pacific, the first day of this week), and keep accumulating from then
on. Fees before it stay excluded for every horse and player; this week's fees
stay.

- Migration `20261015130331`: `fn_ca_fee_counting_start()` returns 2026-10-12 and
  `ca_club_member_fee_totals` counts from it. Guarded on the installed weekly
  version's md5; the fee ledgers are not modified.
- Labels: "Fees This Week" is "Fees Generated" again; detail rows read
  "Cash Fees" and "MTT Fees"; the definitions name the fixed start and say there
  is no weekly reset.
