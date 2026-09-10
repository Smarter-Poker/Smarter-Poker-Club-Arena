# Captured Source Exclusion From Legacy Commission Payments

This is an unapplied coactivation candidate. It does not authorize production
activation, historical backpay, a balance repair, or a source-final assertion.
The parent audit owns combined source, bank, payer, browser and outer-cascade
integration and publication.

## What Changes

Prospective cash commission projections remain available as source evidence, but
legacy Round 2, direct agent claims, unsettled readers and unpaid rollups exclude
them. Historical commission rows keep NULL authority and retain their existing
payment eligibility. Source identity comes from the immutable accepted hand
capture marker, so missing or deferred source facts never fall back to a legacy
payer. No current assignment or membership lookup redefines a captured source.

A nullable marker on `agent_commissions` enables a partial legacy-open index.
The insertion trigger derives the marker from the accepted hand. A supplied
false marker, a later marker change, or a source ID/type change is refused.
Existing original source constraints, commission rates, raw fractional terms,
hierarchy margins, recipients and payout calculations are preserved.

The final `agent_commission_settlements` insertion revalidates the exact still
payable legacy amount and row count for every receipt. This includes historical
windows. A stale old owner cannot retain earlier balance writes if its final
receipt includes captured projections or no longer matches the payable basis.
The exception rolls that call back. No new cross-owner lock order is introduced.

## Stage Order

1. `00-expand.sql` adds the nullable column with a bounded metadata transaction.
   It adds no default and performs no historical backfill.
2. `00-online-index.sql` builds the partial index concurrently, outside the
   activation transaction. Both stages remain unapplied.
3. The coordinated activation transaction must make the accepted-hand marker,
   source authority and source bank/payer changes active together. After those
   required definitions exist, run `00-preflight.sql`, `01-source-exclusion.sql`,
   `02-excluded-owners.sql` and `03-excluded-unpaid-rollups.sql` in that same
   bounded transaction. The preflight requires the valid, ready exact index and
   matching original functions, grants and view options. The classification
   trigger takes the normal relation lock, so an existing projection writer
   cannot cross its installation with an unclassified inserted row.

These files remain under audit documentation. They are not deployment migrations
and must not be copied individually into the active migration directory.

## Native Verification

`native-proof.json` records 30 passing groups on PostgreSQL 17 with 124 captured
tables, 240 captured functions and 177 captured enabled triggers. Actual accepted,
rake-bank, commission-batch, direct-claim, legacy Round 2 and financial dependency
owners execute. This inventory is not a claim that every possible branch ran.

Verified cases include actual historical payments of ten and five chips, unchanged
receipt replay, no false more/owed projection, immutable authority, exact owner
and privilege preservation, and two observed already-compiled old owner races.
The old owners pause in explicitly native-only authentication shims before their
first financial read, resume after function/receipt-guard installation, and roll
back all public row effects at the final receipt. No money owner is replaced by
a synthetic implementation.

Synthetic inputs are identities, historical basis rows, calendar stamps and query
plan cardinalities. Historical rows are not claimed to have been emitted by a
historical production owner. The unpaid view fixture preserves the captured
security-invoker setting and exact grants, including MAINTAIN. The fixture is not
an HTTP or complete RLS authorization certification.

`query-plan-proof.json` covers mixed, captured-only and historical-only cutoff and
receipt queries. Mixed and captured-only access uses the partial legacy index and
does not scan the 100,000 captured projections. Full-window receipt revalidation
must total the actual legacy basis; its historical-only plan is recorded without
claiming constant work or a production latency guarantee.

The native proof binds every local executable/catalog input and the copied and
generated companion fixture inputs. Generated JSON is formatted before hashing,
so normal repository formatting cannot silently orphan the tested bytes.

Run with the reviewed payer fixture:

```sh
ROUND1_FIXTURE=/path/to/2026-09-10-rakeback-payer-proof/round1-owner \
bash docs/audits/2026-09-10-accounting-legacy-exclusion/run-local.sh
```

The companion fixture is archived at
`7adbfb02544b68ccc1754c51f11d2f61fa406180`. The runner copies its inputs into a
private temporary directory and runs PostgreSQL over a private Unix socket.
It never writes another checkout or invokes a live economic function.

## Integration Boundaries

Independent pure-historical same-window, overlapping-window and direct-claim race
verification is owned by the peer lane. The full outer Union cascade, original
club-lock graph, producer/funding finality, legacy Round 1/player exclusions,
capability activation and browser integration remain parent integration gates.

The separate club daily commission series retains its existing compatibility
accrual meaning. It must not be presented as exact captured entitlement or actual
cash paid. Only the unpaid legacy projections are changed by this candidate.
