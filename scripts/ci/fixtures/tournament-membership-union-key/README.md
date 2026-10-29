# Original tournament membership Union key

The original `fn_union_pnl_evidence_report` and its helper bodies remain unchanged.
Migration `20261029032041` adds only
`union_pnl_inventory_touches_tournament_union(row_id,union_id)` for
`source_name='tournaments'`. It retains the PK, week selector and event-ordered
identity index used by other owners. Union is raw nullable TEXT: no UUID filter,
hash, expression, source rewrite, math change, GEN change or index retirement.

The actual original index keys source/row/event and includes Union as payload.
Actual custom and generic report plans applied Union as a residual filter. The
original membership prefix exceeded 60 seconds before receipt or satellite work.
A bounded live sample read 512 events across eight week bins and selected sixteen
identities: fifteen had target Union in their first event (histories of 6–8 or
234 rows); one NULL-Union miss had 72 rows. This is not a population estimate.
The actual old identity index was 1,640,767,488 bytes. The new key removes event
ordering/payload width for this lookup and admits Union into the search condition.
Actual whole-report capacity must be verified after protected installation.

`actual-table-authority.json` retains the actual full catalog evidence.
`meaningful-table-contract.json` binds all nine columns, both constraints, all
three existing indexes, full normalized trigger fields/definition and original
owner/ACL/RLS/policies. Only generated OID references are normalized into logical
identities; the migration also snapshots the complete raw trigger catalog before
and after qualification and requires exact equality. Root independently proved
this literal projection equal to production before any index DDL. String ordering
is explicitly C to preserve production/native comparison.

Five directly connected original owner preimages use their exact full-definition
MD5 and complete semantic metadata (only generated identity OIDs are represented
by role/language/schema names). The full definitions and raw metadata of all 22
connected owners are captured and compared before/after. Original source65 and GEN
are required; their full definitions are retained and compared. No owner is
redefined. The native fixture executes the real original touched query and helpers
and the real immutable trigger body. Source65/GEN and maintenance authority values
are explicit controlled native boundaries, not original65/245 execution proof.

Run the existing PostgreSQL 17 qualifier on owned scratch:

```sh
python3 -B scripts/ci/test-tournament-membership-union-key-postgres.py \
  --pg-bin "$PG_BIN" --scratch "$OWNED_SCRATCH" --output "$OWNED_SCRATCH/membership.json"
```

The existing required accounting launch-floor gate invokes it. It proves complete
original query counts with duplicate events/NULL/opening/projection cases, natural
custom/generic index selection, all old rows/indexes/function metadata/raw triggers
preserved, real interrupted-CCI invalid-prefix refusal, concurrent append writers,
valid-prefix history-tail failure/resume, role/window/freeze/GEN/ACL/trigger/index
refusals and immutable producer enforcement. NULL/malformed/empty/36KB compressible
Union strings and incompressible strings through the original admitted boundary
remain admitted by the new index. Original over-width refusals stay original.

Use only the existing protected-main applier: one CCI with the shared 600-second
budget, twelve-minute admission reserve and original window/snapshot guards. An
invalid/unknown prefix refuses; inspect the owning operation and actual catalog.
A valid prefix after body/history refusal is qualified without dropping/rebuilding
it. Native evidence does not install this migration or certify production speed,
book closure, money, Monday automation or a future natural Monday execution.
