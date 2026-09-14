# Native conservation fixture

`production-definition.json` contains the exact conservation reader and its two payment-candidate consumers captured read-only from production on September 14. The baseline hash is verified inside PostgreSQL before the candidate is run. Table rows are synthetic; the runner never connects to production.

The fixture deliberately makes any payout-reconciliation invocation fail. The actual consumer check proves that a fully accounted zero-delta event never enters that path. It does not simulate or qualify a successful payout. Keep that boundary when extending these tests.

Run from the repository root:

```sh
python3 scripts/ci/test-conservation-corrections.py \
  --fixture scripts/ci/fixtures/conservation-corrections/production-definition.json \
  --candidate supabase/migrations/20260914123403_conservation_observes_house_funded_corrections.sql \
  --output artifacts/conservation-corrections
```
