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

`source-history.json` fingerprints both source repositories at capture. New,
modified, or missing historical SQL refuses qualification. Forward entries are
currently forbidden: adding a migration requires a refreshed, independently
qualified baseline and history inventory. Hash admission alone never proves new
SQL was applied. Historical data transformations are not executed against an
empty database to simulate financial history.
