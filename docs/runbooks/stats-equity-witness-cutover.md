# Durable All-In Equity Witness Cutover

This is a staged production change. `ca_hand_facts` is larger than 2 GB, so its
partial covering index must be built concurrently. Never run a blocking index
build on this table and never infer fleet readiness from the first row whose
`all_in_equity_owed` value is true.

The release is complete only when every stage below has its receipt. The two
unapplied transactional stages remain `.sql.pending` until their live
`apply_migration` calls assign durable versions. Do not promote either reserved
filename, guess a replacement timestamp, or insert directly into
`supabase_migrations.schema_migrations`.

For every direct read or concurrent-index session, configure libpq with
`PGSERVICE` and a mode-0600 `PGPASSFILE` (or ordinary PGHOST/PGPORT/PGUSER/
PGDATABASE variables). Never place a password-bearing database URI in argv.

## Required order

1. Resolve exactly one staged-or-promoted source for each of
   `all_in_equity_coverage_is_witnessed_at_runout`,
   `stats_equity_witness_covering_index_is_ready`, and
   `stats_witness_audit_uses_durable_runout_evidence`. While a stage is pending,
   its only source must end in `.sql.pending`; after application, its only source
   must use the ledger-assigned version and end in `.sql`. Both forms existing
   at once is an ambiguous release and aborts the cutover. Confirm a tested
   rollback artifact exists for the engine deployment.
2. Require the unique, already-applied
   `20260908233111_all_in_equity_coverage_is_witnessed_at_runout.sql` ledger
   receipt and prove its stored statement is byte-equal to source. Never
   resubmit the shape migration in this cutover. Read-only verification must
   also prove
   the exact `all_in_equity_owed` column/default and its `NOT VALID` shape
   constraint before deploying the writer.
3. Deploy the engine build that freezes `allInRunout`, `allInRunoutStreet`,
   `allInEquity`, and `allInEvReturned` into the accepted hand action row and
   materialises `all_in_equity_owed`. Drain every prior engine process. Record:
   - the full 40-character Git SHA;
   - the UTC instant at or after the final old process exited; and
   - fleet evidence that every live table owner reports that SHA.

   That instant is the writer cutover boundary. A row written by one upgraded
   process is not fleet evidence.

4. From one direct PostgreSQL 17 `psql` session, outside a transaction, run:

   ```sh
   PGSERVICE=club_arena_cutover PGPASSFILE=/private/operator/.pgpass psql -X \
     -f scripts/ops/build-stats-equity-witness-index-concurrently.sql
   ```

   The script serializes operators with a session advisory lock. If an earlier
   concurrent build left an invalid or drifted same-name index, it drops that
   index concurrently and rebuilds it. It retains a valid exact index and ends
   by asserting `indisvalid`, `indisready`, key order, INCLUDE, and predicate.

5. Apply the staged `stats_equity_witness_covering_index_is_ready` source and
   then the staged `stats_witness_audit_uses_durable_runout_evidence` source,
   one at a time through Supabase `apply_migration`. Before each call, prove its
   name is pristine. After each call, capture its unique ledger-assigned version
   and byte-verify the stored statement against the staged source. A timeout is
   an unknown outcome: query by migration name and verify bytes before retrying.
   The index-ready gate must see the valid concurrent index before the audit can
   switch. The two ledger-assigned versions must sort after the already-applied
   shape receipt and in gate-then-audit order.
6. Stamp the immutable fleet boundary using the evidence from step 3:

   ```sh
   PGSERVICE=club_arena_cutover PGPASSFILE=/private/operator/.pgpass psql -X \
     -v writer_sha=0123456789abcdef0123456789abcdef01234567 \
     -v cutover_at=2026-09-08T23:15:00.000000Z \
     -f scripts/ops/set-stats-equity-witness-fleet-cutover.sql
   ```

   Replace both example values. The timestamp must include an explicit offset.
   An exact replay is a no-op; a different timestamp or SHA is refused. The row
   cannot be updated or deleted. A correction requires a reviewed forward
   migration.

## Source-seal the two receipts before publication

After both applications succeed, rename each `.sql.pending` source to the exact
14-digit version returned by its unique migration-ledger row, without changing
one SQL byte. The gate's ledger-assigned version must sort before the audit's.
Run the staged-or-promoted resolver and the migration-ledger artifact verifier
for both names, rerun the PostgreSQL 17 probe, commit those renames, and publish
that source-sealing commit with the engine release. `supabase db push` is not a
fallback for this lane: it cannot express the required shape/deploy/index/gate
sequence and must never be used to manufacture or repair these receipts.

## Release checks

Run these as read-only queries after the stamp:

```sql
SELECT public.ca_stats_equity_witness_readiness();

SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
FROM pg_index i
WHERE i.indexrelid =
      'public.idx_ca_hand_facts_equity_owed_played_at'::regclass;

SELECT public.ca_stats_health()->'equityWitnessReadiness';
```

Immediately after cutover, readiness must say `configured: true`,
`windowLabel: "collecting"`, and `windowReady: false`. During that interval the
engine publishes the legacy `*_7d` Prometheus gauges as `NaN`, never raises
from a partial denominator, and clears any stale pre-cutover coverage alert
using the explicit collecting state. `windowReady` can become
true only after both seven days have elapsed and a witness audit has run after
`fullWindowAt`; then the gauges and the 99%/50-seat page resume.

Finally run `scripts/dev/probe-stats-equity-witness-pg17.sh` in the release SHA
and retain its output with the database migration receipts and fleet-SHA proof.
