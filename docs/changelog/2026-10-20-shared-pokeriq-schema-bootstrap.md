# Complete Shared PokerIQ Schema Bootstrap

Legacy migrations do not form an empty-database schema lineage: the first Hub
migration references an absent `clubs` table, and historical migrations include
financial transformations and non-SQL source artifacts. Applied history is
preserved byte for byte. A complete native schema-only baseline now supplies the
new empty-schema route, including private/archive schemas, real extensions,
roles, constraints, routines, ACLs, policies, publications and comments.

The dump and independent source catalog were captured under one exported
read-only PostgreSQL snapshot. No application rows or authentication secrets
were exported. Provenance checks and recognizable secret-literal scans refuse
changed or unreviewed source. Future SQL cannot be admitted by hash alone:
a refreshed qualified baseline is required.

Local PostgreSQL tests qualify the catalog's sequence limits, ownership,
column/table ACLs, policy roles, partitions, composite/domain/enum/range types,
aggregates, publications, comments and lost-right detection. The Mac's complete
restore correctly refuses missing provider extensions. The directly triggered
workflow uses the exact pinned official Supabase PostgreSQL 17.6.1.063 image,
without network or production secrets, and compares a full rebuild with the
independent source catalog. Full-schema rebuild verification remains pending
that actual workflow execution; focused fixtures are not a substitute.

This is source and test tooling only. No production migration, application row,
engine replacement or historical financial replay is part of this change.

Actual image qualification exposed PostgreSQL17 grantor authority: a generic
initdb superuser cannot stand in for the source bootstrap principal at role
OID10. The source identifies that principal as `supabase_admin`. Bootstrap now
retains this identity, uses a separate local supervisor, and preserves every
captured membership grantor and option. The native regression reproduces the
old 42501 and checks all 32 memberships plus 37 role capability/configuration
contracts after repair. Failure receipts retain nonsecret phase/object context
and SQLSTATE while omitting routine bodies and raw detail.

The real provider image also showed that dropping the initializer's `plpgsql`
can break provider extension hooks. With the captured bootstrap principal, its
initial owner/version/schema already match the source contract. Qualification
now reads and retains that exact builtin, refuses any mismatch, and tests that
its identity survives the check. No extension is stubbed or silently replaced.
