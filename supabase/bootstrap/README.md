## Fixed audit scope

The owner selected immutable Arena source revision
`ffa19fa61761da13c73b4442558a477704cbccca` as this audit cutoff. Qualification
covers the schema-only baseline plus the four declared transitions; all later
migrations are excluded. It does not certify the schema intent or installation
of later main changes. The workflow checks out that exact revision separately
for the unchanged strict history checker. Its current implementation still
checks every consumed forward SQL file against the four exact hashes. Future
files are never silently added to the inventory or executed. Successful rebuild
receipts identify `auditedSourceRevision`, `qualificationScope` and
`laterMigrationsExcluded` explicitly.

# Shared PokerIQ schema bootstrap

This is a schema-only PostgreSQL baseline for a new, empty, isolated database.
It is not a production migration or a financial-data replay. Never run it
against an existing database, add it to `supabase/migrations`, or mark historical
migrations reverted. Existing deployed migration bytes remain unchanged.

`pokeriq-20261020.sql` is the complete native schema export, including private
and archive schemas. The manifest records its checksum and source provenance.
The independent catalog reference must come from the same exported PostgreSQL
snapshot as the dump. Current ACLs are fidelity evidence; they do not establish
that every historical privilege is the desired minimum.

Run `scripts/schema-rebuild/verify.py --scratch OWNED_DIRECTORY --result NEW_JSON
--pg-bin PG17_BIN_DIRECTORY` as an unprivileged user. It creates its own
Unix-socket-only database, rejects supplied database connection settings, checks
all exact extension versions, restores the whole baseline in one transaction,
and compares the result with the independently captured source catalog.
No application rows, passwords, scheduled-job rows, or vault secrets are copied.
Source role capabilities and memberships are retained, with every source role
forced to NOLOGIN in the isolated target.

The pinned official Supabase PostgreSQL image in the directly triggered workflow
provides the managed extensions unavailable on the Mac. Its execution uses no
network and receives no production secrets. The workflow must pass on the actual
image before calling a full rebuild verified.

`source-history.json` fingerprints immutable SQL bytes in both repositories at
named capture revisions. New, modified, or missing source SQL refuses qualification.
It is an audit of source history, not a claim that every historical file was
installed byte-for-byte. `historical-ledger-reconciliation.json` preserves the
known source/ledger differences and descriptive aliases. The independently
captured native schema is the authoritative current-snapshot reconstruction.
Historical financial transformations and trigger-registry rows are not replayed.
The former two pending schema migrations are now installed. Four exact inputs
are admitted by fixed paths and SHA256: pending hourly-sweep `20261022162545`,
post-capture installed opening `20261022201306`, and pending journal-index
`20261022223439`, and post-capture installed bounty-pick `20261022223610`. After
independent baseline catalog equality, the runner executes its unchanged SQL as
`postgres`, preserving the concurrent-index preamble outside its original
transaction. It never calls the created business routines. An independently
retained native metadata fixture specifies three new tables, three explicit
indexes, seven routine postimages and three comments; every other catalog field,
role capability and membership must remain equal. The remaining transitions are described below; no other forward SQL is admitted.
The seven installed mystery-bounty source/ledger discrepancies are
recorded separately and never replayed.

Native PostgreSQL parses independently captured and restored CHECK, trigger, and
view definitions before comparison, preserving all other metadata. Regression
cases reject changed predicates, bounds, and view expressions. The isolated
restore supplements exact captured GraphQL schema ACLs omitted by the provider
export and atomically restores three extension owners together with their shared
OWNER dependencies. Supported partition detach/reattach DDL restores inherited
primary-key flags changed by native dump round trips. Full catalog comparison
still checks every captured field; these repairs never run against production.

Native `pg_dump` omits one captured invalid index on `chip_transactions`. The
isolated restore recreates that exact nonunique definition, checks its owner,
table, descriptor and unconstrained ready state, then atomically preserves
`indisvalid=false`. It remains unavailable to the planner, as captured. Negative
fixtures reject changed definitions, readiness and unique constraint indexes.
This preserves observed metadata; it does not repair a production index.

The frozen a18ab3ebc61a5f45ce5dab05d7da28d2f6ed99bb source audit adds the already captured hourly-slot schema postimage without replaying its historical updates. The exact 20261022201306 opening reserve-reuse migration was installed after the snapshot and is applied locally as the second hash-bound DDL transition after 162545. Independent two-routine postmetadata and every other catalog field, role and membership are compared; no business routine is called. The prior 672c full-image pass remains evidence for its earlier inputs; the expanded candidate needs its own full-image qualification.

The post-capture opening DDL requires its original money-RPC authorization registry entry. Schema-only dumps omit that configuration row. The isolated verifier restores only the exact source-declared and independently read-back opening authorization (one governance configuration row, no application or financial rows), with the actual captured writer detector and event guard enabled. It verifies exact empty/one-row state before and after unchanged DDL; the full catalog and role checks remain mandatory.

Frozen a3bf961d0a9f142ea2be79b4133f8068fe8034e7 adds exactly one further schema input: 20261022223439, the adaptive journal metadata cover. It is absent from the retained snapshot and current read-only index/ledger checks. Only its exact original concurrent DDL and read-only shape assertion are applied as the third local transition. A source-derived one-index descriptor and full parent preimage define the expected delta; every other catalog field and role remains checked. This neither builds nor certifies an index in production, nor claims production scan performance.

Frozen ffa19fa61761da13c73b4442558a477704cbccca adds exactly the 20261022223610 mystery-bounty pick function DDL as a fourth local input. Its source body and complete security metadata match independently read current metadata, while its historical ledger SQL hash differs explicitly. The retained snapshot has the exact older routine. Only that one routine definition hash changes in the independently specified expected catalog; every other field, routine, role and membership remains checked. No choice, prize or business function is invoked.
