# The Conservation Report Reads Treasury Legs From Covering Indexes

Cashier "Reconcile Now" returned 500 on production: the conservation report
timed out (30 s for Deep Stack Society against the 8 s request budget). Its
bank sums filter on club_id, which the existing treasury indexes did not carry,
so every treasury leg since the August 31 baseline (565,800 for one club) was
read from the heap.

Two partial covering indexes keyed (entity, club_id, created_at) INCLUDE
(amount) make both sums index-only under the custom and generic plans
(migration `20261015165657`). After the build: Deep Stack Society 0.21 s,
SHARK CLUB 1.7 s, Club JAQK 1.4 s. The report function is unchanged. The indexes
were built concurrently in production first, as the migration records.
