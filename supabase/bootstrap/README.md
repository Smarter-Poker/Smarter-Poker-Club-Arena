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
The former two pending schema migrations are now installed; no forward SQL is
admitted or executed by this baseline.

Native PostgreSQL parses independently captured and restored CHECK, trigger, and
view definitions before comparison, preserving all other metadata. Regression
cases reject changed predicates, bounds, and view expressions. The isolated
restore supplements exact captured GraphQL schema ACLs omitted by the provider
export and atomically restores three extension owners together with their shared
OWNER dependencies. Supported partition detach/reattach DDL restores inherited
primary-key flags changed by native dump round trips. Full catalog comparison
still checks every captured field; these repairs never run against production.
