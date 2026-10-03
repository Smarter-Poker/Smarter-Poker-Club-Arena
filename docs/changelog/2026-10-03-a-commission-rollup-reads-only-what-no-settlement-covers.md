# A commission rollup reads only what no settlement covers (2026-10-03)

## What happened

Round 2 of the weekly close (`fn_settle_accounting_commission_stage`) ends by recomputing
`agent_commission_unsettled_rollup` for every (club, agent) it paid. The rollup counts a commission
row while it is open (`settled_at IS NULL`) and no `agent_commission_settlements` period of its pair
covers its `created_at`. Routing v3 never sets `settled_at`, so the recompute read every open row
the pair ever had and probed the settlements for each: 517 s of the 68-minute Midway close of
2026-10-01 (auto_explain, job 391, 142 pairs). The still-open week 2026-09-28 alone holds 3.86M
rows for those pairs, and the history only grows.

## Fix

Migration `20261003091015_a_commission_rollup_reads_only_what_no_settlement_covers` (one exact
anchor on the 2026-10-03 preimage): the pair's settlement periods that cover anything
(`period_start < period_end`) are merged into the ranges they do not cover, and only those ranges are
read through `agent_commissions_open_idx` (club, user, created_at) INCLUDE (amount, id). A row whose
`created_at` is NULL or `'infinity'` can never be covered and is read by its own index condition.
The upsert is unchanged.

## Proof

Production, read-only, 2026-10-03 09:56Z, both forms in one statement (one snapshot), 145 pairs
(every pair with a settlement plus pairs active in the last 10 minutes): old and new both md5
`48af8c6d427aa4778672677f2b604e1f`, 7,523,239 rows, owed 2,365,141.87. The new form alone read them
in 55.6 s, almost all of it the still-open week the next close covers.

## What does not change

Which rows count, the owed amount, the row count, the oldest row, the upsert and who calls it.
