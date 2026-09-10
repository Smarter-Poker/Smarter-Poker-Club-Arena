# Phase 3 database expansion and rake restoration

Two reviewed database changes were applied and their installed definitions verified on 2026-09-10.

- The versioned final-deal expansion installed at migration `20260910125453`. All 16 functions, five tables and three immutable triggers matched the reviewed source and expected permissions. Policy defaults are 120 seconds. The nine previously missing application RPC names now exist.
- The bounded rake attribution retry restoration installed at migration `20260910130319`. The function body matches `be08a61e1a867519048c4692b41ab1fd`; ownership, permissions, configuration, the settlement lane helper and attribution function are unchanged. Its 35-assertion native rollback proof is recorded separately.

The expansion remains inactive. No claim of Phase 3 completion follows from these additive changes. The strict cutover still requires compatible manager request fencing, current terminal integration with atomic payout batches, and guarded native settlement/replay proof. Compatible client and engine deployment must be verified before activation.

Evidence: `docs/audits/2026-09-10-phase-three-production-expansion-and-rake.json`.
