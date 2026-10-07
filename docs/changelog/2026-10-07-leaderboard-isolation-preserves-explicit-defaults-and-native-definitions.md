# Leaderboard Isolation Preserves Explicit Defaults And Native Definitions

## Demonstrated Restore Blockers

The protected qualification run `37613404509` refused its complete catalog before Auth or financial tests. Four schema ACLs and 238 relation ACLs differed in content, not order. The source contains exactly four schemas and 238 grantable relations with explicit ACLs equal to their defaults. The isolated replay coalesced a raw NULL destination ACL to its default before deciding to skip restoration, losing the explicit representation. A native PostgreSQL 17 reproduction confirmed that false-success path.

Four CHECK constraints also changed their native deparsed representation when PostgreSQL reparsed array casts during ordinary dump/restore. One view gained two internal secondary-UNION target aliases. Native reproductions matched the source and restored view hashes exactly. These are isolated restoration problems, not permission to change production business definitions or omit catalog fields.

## Repair And Evidence Boundary

The intended correction retains raw NULL identity before any effective-default handling and requires an explicit source ACL to have an explicit exact destination postimage. Narrow guarded isolated definition recipes restore only the five proven definitions from their authoritative original syntax, with source drift refusal and exact destination preimage/postimage checks. They execute inside the existing atomic restore, never against production. Full catalog equality, role/security attributes, validation and cleanup remain mandatory.

Native empty-ACL coverage also exposed PostgreSQL's rejection of a zero-dimensional empty array passed to `aclexplode`. Empty arrays now produce no privilege-iteration rows without changing the target or raw stored ACL. Exact readback still distinguishes an explicit empty ACL from NULL and full privileges. The native regression proves the original skip condition fails and the repaired source preserves the complete source export, including column grants.

Bounded opaque diagnostics distinguish NULL, explicit empty and nonempty ACLs without exposing identities or ACL contents. The maintained native regression step must execute the directly affected tests. Local or hosted source tests do not certify the full current-schema restore, actual Auth matrix, financial behavior, installation or publication; those results are recorded separately in the existing closeout checkpoint.

No production migration, financial fixture, settled record rewrite, wallet movement, new scheduler or client release is included in this tooling correction. The coupled Promo-only UI remains separate until its backend is qualified and installed.
