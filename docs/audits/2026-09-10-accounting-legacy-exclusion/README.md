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
payer. New cash commission insertions require the original accepted hand receipt.
Its immutable marker classifies the row; a missing receipt refuses the insertion.
No current assignment or membership lookup redefines a captured source.

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

`native-proof.json` is the unchanged 30-group baseline receipt for commit
`b332bbefba8dca6a06b7d3de39631240cd6f9538`. Its input hashes identify that
commit, before the September 11 admission change; they must not be represented
as a rerun against the newer helper. The baseline uses PostgreSQL 17 with 124 captured
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

## September 11 Prospective Admission Fix

`source-admission-proof.json` records 11 focused native groups against the new
helper. The private runner verifies a fresh PostgreSQL 17 data directory, private
Unix socket and empty TCP listener before loading any fixture SQL. Its environment
does not inherit database connection variables. The stopped cluster is retained.
The historical same-window or overlapping-window race diagnostics are not invoked.

The actual accepted owner emits historical hand 1000001 before marker activation
in the companion `exercise.sql`. That is a known historical source, despite the
old baseline log's inaccurate "unknown source" label. The fixture source now uses
the correct description. Historical commission rows remain explicit synthetic
liability inputs; they are not claimed historical production-owner emissions.

The new proof checks actual accepted, bank and batch writers for captured rows,
known historical accepted-hand classification, unknown new cash refusal with no
row effects, preserved tournament source behavior and private function privileges.
A pre-existing no-hand historical liability remains payable: the actual legacy
claim pays seven chips once, and its replay makes no additional movement. That
existing row does not authorize another missing-hand projection.

This matches the approved cash admission owner's historical branch at archive
`27fdaf5d83c4368251bc79f4bb932b423017c9ef`,
`docs/audits/2026-09-10-union-accounting-proposal/source-authority/04-cash-admission.sql`.
When only known legacy bank evidence exists, that branch returns before inserting
any contributor receipt or allocating a new commission. A source lookup alone is
therefore not permission for a new payable projection. Existing historical rows,
including those without an accepted hand, are untouched. No cutoff date, current
membership lookup, backpay or new payout policy is introduced.

```sh
ROUND1_FIXTURE=/path/to/2026-09-10-rakeback-payer-proof/round1-owner \
/opt/homebrew/bin/python3 \
  docs/audits/2026-09-10-accounting-legacy-exclusion/run-admission-local.py
```

The 11 groups partly overlap baseline concerns and are not added to the baseline
count as unique programme coverage. The current proof hashes its changed helper
and focused runner, while retaining the baseline commit as separate evidence.

## Integration Boundaries

Independent pure-historical same-window, overlapping-window and direct-claim race
verification is owned by the peer lane. The full outer Union cascade, original
club-lock graph, producer/funding finality, legacy Round 1/player exclusions,
capability activation and browser integration remain parent integration gates.

The separate club daily commission series retains its existing compatibility
accrual meaning. It must not be presented as exact captured entitlement or actual
cash paid. Only the unpaid legacy projections are changed by this candidate.
