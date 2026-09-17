# Accounting club foreign keys stay indexed

Post-deploy browser run35266814559 stopped before creating fixtures because
four new accounting references to clubs lacked a valid, non-partial index
starting with the referencing column. Unindexed lookups can exceed the club
retirement request budget and strand certification fixtures. The same strict
catalogue check passed in run35249791396 at16:58:57UTC.

The reserved migration adds only those four missing indexes. A read-only
catalogue check reproduced all four gaps; measured child tables contain6453,
2,0 and0 rows, with the largest approximately1.03MiB. The existing bounded
single-transaction index migration is the baseline: a one-second lock budget
and five-second statement budget, with no DDL during the maintenance window.
Financial records, permissions and foreign-key behavior remain unchanged.

Regression protection remains the existing strict `check-club-fk-indexes.mjs`
production preflight and `fn_ca_fk_index_gaps` catalogue query. Installation,
valid/ready index readback and a zero-gap result are required before accepting
the final browser certificate. No manifest entry is needed for indexes: this
change adds no table, column or function. No check or assertion is weakened.
