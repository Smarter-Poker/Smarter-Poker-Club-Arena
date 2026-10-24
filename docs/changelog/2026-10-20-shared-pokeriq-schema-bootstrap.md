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

The full atomic restore reached constraint creation and exhausted PostgreSQL's
default lock table. A bounded native fixture reproduces SQLSTATE 53200 and its
`max_locks_per_transaction` hint, proves complete rollback, then succeeds with
the inventory-derived isolated budget. The captured relation/index, possible
TOAST, named-object and dependency allowances require 32,485 lock slots; with
100 isolated connections the rounded budget is 512 locks per transaction.
Qualification reads those settings back. Production configuration and the
single-transaction restore are unchanged.

Current-main qualification refresh: the source history guard correctly refused four concurrent migrations. Read-only history and routine preimages distinguish two installed versions (174041/190723) from two pending versions (182843/184651). A new consistent schema/catalog snapshot captures production faithfully. Only the two exact pending guarded DDL inputs are applied locally after baseline fidelity passes, then checked against independently reviewed routine/ACL/constraint expectations with all other catalog fields unchanged. No production installation, financial-history replay, report, or payment invocation occurs. Full image qualification remains pending.

The pinned Supautils 3.0.1 provider rejects a generic superuser creating an event trigger for a non-superuser callback owner (XX000). The isolated restore now creates each of the 17 captured event triggers as its captured owner, preserving the original definition, subsequent owner statement and enabled state. Exact owner/function anchors refuse drift. The existing actual-image role regression reproduces the provider error and proves the captured-owner correction; first-line error/HINT diagnostics redact quoted values, URLs and credential-shaped tokens and exclude DETAIL/CONTEXT. Full runtime qualification remains pending.

The real image restored the entire baseline and the provider trigger regression passed, then independent catalog comparison found differences in 3 extensions, 64 relations and 2 schemas. Bounded diagnostics now identify up to 100 changed objects and 24 fields per object, retaining aggregate omission counts; SQL expressions/comments are represented only by hashes and lengths. Strict full-catalog equality remains required. No fidelity mismatch is waived.
