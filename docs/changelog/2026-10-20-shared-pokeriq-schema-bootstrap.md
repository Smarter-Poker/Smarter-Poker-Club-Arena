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
