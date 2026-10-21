# Mutual friends count players once

The public profile RPC joined reciprocal accepted friendship projections directly. KingFish viewing SaVaGe therefore received four identical MamaPriya rows (2 x 2), and the UI counted those rows as four mutual friends.

Intersect the friend IDs before resolving each profile. Preserve accepted-status filtering, the authenticated caller boundary, arena aliases and avatars, ordering, 100-player limit, grants, security and search path. No friendship records are removed or changed; this is a database-only read correction.

The native PostgreSQL regression executes the captured live preimage and exact migration. It reproduces four rows before, one after, and checks extra duplicates, distinct players, pending requests, symmetry, anonymous/NULL inputs, avatar fallback, unchanged ACL/security and replay refusal. The pull-request Mutual friends are unique players workflow runs it for migration changes. TypeScript and applicable source-contract results are recorded in CHECKPOINT-savage-mutual.md.
