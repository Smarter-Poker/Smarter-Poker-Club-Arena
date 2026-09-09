# The Financial Gate Does Not Scan The Live Settlement Ledger

The engine deployment gate ran this healthy-state query before the announced
maintenance break:

`SELECT count(*) FROM public.ca_settlements WHERE state NOT IN (...)`

Production evidence at 02:50 UTC on 2026-09-09 showed the query still active
after 43 seconds, reading data files with a parallel worker. The table held an
estimated 4.34 million rows and occupied 3.8 GB. During the same interval the
loaded fleet's rolling next-hand p90 rose from about 2.0 seconds to 5.5 seconds
and its maximum rose past 21 seconds. This read-only deployment check was
competing with the live settlement path it was supposed to protect.

PostgreSQL already enforces the exact legal state set with the validated
`ca_settlements_state_check` constraint. The gate now reads that one catalog
row, requires it to be validated, and compares its complete state set with the
application's expected set. PostgreSQL's validated constraint proves all
existing rows and rejects future illegal rows without reading the ledger heap.

A regression test forbids restoring the full-table count and pins the catalog
constraint proof. The other conservation checks are unchanged.
