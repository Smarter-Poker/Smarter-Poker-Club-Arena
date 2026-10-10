# Cashier default totals read each range once

The current Statements browser check received HTTP 500 from the totals RPC;
PostgreSQL recorded statement cancellation (57014) at its unchanged eight-second
limit. This database-only change reduces the work in the unfiltered owner/all
aggregate. It does not retry the RPC, increase its timeout, or alter authorization.

The private rows helper now groups each receipt/movement range by direction once,
then subtracts the already-qualified omitted movements. Separate row, non-null
and NaN counts preserve totals when a mirrored amount is NaN. Every other filter,
scope, page and export path remains byte-identical. The public totals wrapper is
unchanged. Horses and human players use the same predicates.

A narrower partial movement covering index supplies amount and endpoint IDs.
The existing broader movement index remains for filtered reads. Index-only with
the old helper showed no benefit, so this change includes the qualified aggregate.

## Installation

After protected delivery, inspect the actual source preimages and index state.
Run `scripts/ops/build-cashier-direction-totals-index-concurrently.sql` as its
single top-level statement through the maintained direct/session connection;
do not wrap it in a transaction or send it through a transaction-wrapped API.
An unknown result requires readback of that operation, not another build.
Then apply reserved migration `20261010011934` through the supported migration
ledger route outside the DDL break window. Its two-second lock cap and exact
function/index guards refuse changed inputs and replay. It preserves the entire
helper authority tuple and public wrapper. Verify installed history, post-image
`45d82a8afb00381ee4e784e7ffdf097d`, index validity/readiness/liveness and authority,
then run the authorized Statements page check at the current release.

## Evidence and limits

Isolated PG17 aligned-planner qualification used 365,000 synthetic range rows,
199 omissions and the existing boundary row (364,802 retained), with sparse and
dense viewer cases. Whole-function reads fell from 7,586/7,587 to 6,243 blocks;
measured times were 46.035/46.314 ms versus 42.830/44.918 ms. The complete scope,
filter, authorization and numeric-boundary matrix matched. These are synthetic
measurements with fresh shared buffers, not a cold OS cache or production-load
certificate. Index-only was rejected; the fixture's initially missing competing
index was corrected before the retained measurement.

The dedicated installation qualification passed missing/invalid index,
wrong-preimage and replay refusals, successful installation, unchanged authority
and wrapper, and verified cluster shutdown/removal. The maintained Cashier CI
fixture now retains these guards and a small independent unlimited-row oracle,
including mirrored NaN amounts and boundary receipts. No financial writes occur
outside its isolated fixture. Production installation and live verification are
separate, pending operations. No engine replacement is required.
