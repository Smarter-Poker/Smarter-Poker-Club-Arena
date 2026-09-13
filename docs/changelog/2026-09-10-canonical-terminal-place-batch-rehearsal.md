# Canonical terminal place batch: local verification checkpoint

The prepared normal-place contract now derives an immutable version-2 batch from the current cash authority's real canonical payouts. It preserves legacy version-1 behavior, verifies durable standings and exact money receipts, and permits only the existing terminal marker update after full terminal proof. The native fixture also preserves its seat authority wrapper and acquires the complete settlement lane before seat rows.

**Stage B is NOT APPLIED.** Final-deal v2 implementation was rejected by automatic approval review and remains absent. Its readiness branch is pending and unexercised. A read-only prerequisite now refuses the whole candidate before locks or DDL when that helper is missing; helper existence alone is not certification.

Verified at 2026-09-10T14:01:23.863361+00:00 using the existing owned PostgreSQL full_stage1 database. The guarded runner passed 15 explicitly listed checkpoints and captured 22 actual final function definitions, owners, ACLs and settings after every composition step. Intermediate source hashes are recorded separately as base_source_definitions.

- Native zero-default Spin draw and launch, genuine finish claim and actual terminal settlement passed.
- One payout of 2.00, rake 0.24 attributed to three users, a settled version-2 batch and all three escrow balances zero and closed were observed.
- Exactly two live-seat capabilities were minted and consumed under one token. No capability rows or settings remained.
- A late receipt failure rolled back the complete observed state, including the new batch. Completed replay and resolver returned the identical receipt without state changes.
- All deferred constraints were forced before the intentional PASS exception. The outer transaction restored public function metadata, all triggers, seat-authority table metadata and all 34 tracked table states exactly, preserving the independent move proof's 12-event baseline.

The matching before/after state SHA-256 is 11223684b4be7159a173ff245eb57479139e4280dc16ab1057cdbf4c02fcb639.

| Exercised function                                                             | Actual body MD5                  |
| ------------------------------------------------------------------------------ | -------------------------------- |
| fn_complete_tournament_terminal(uuid,uuid,text)                                | 96a61ea5e16560735bcb70b355aa79ab |
| fn_settle_tournament_rake(uuid,text)                                           | be08a61e1a867519048c4692b41ab1fd |
| fn_settle_tournament_places(uuid,uuid)                                         | e3d8f6cf87a19f1789c0450369c1cb90 |
| fn_ca_verify_terminal_place_batch(uuid,boolean)                                | 00291eddbd2135ba6b45ea4f731c43fc |
| trg_freeze_batched_tournament_place()                                          | 5c00f4babf2e07dd86e9f47e14588b07 |
| fn_tournament_finish_readiness(uuid,uuid)                                      | 993e6e1de9edba2fe235d86ff6c243c9 |
| fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid) | 7e4c7398d7daa25518b6737197fa3172 |

Full runtime pins, tracked inputs, source block SHA-256 values, terminal observations, the 15 checkpoints and the reproduction command are in docs/audits/2026-09-10-canonical-terminal-place-batch-native.json.

Limits: custody and eliminated standings were seeded synthetically; registration was not exercised. This new batch proof covers the one-winner Spin path. Broader Bubble, paid/partial, zero-pool, sparse/rounded ladder and adverse evidence variants remain unverified under this block. No hand/terminal concurrency result is claimed here. The native seat guard/wrapper is a strict retained-fixture composition, not a production installation requirement. Historical overwritten-wrapper and uncontracted-batch refusals remain separate negative reproductions.

Python syntax compilation and git diff --check passed. No production database changes were made by this rehearsal.

Subsequent source correction and three real Bubble paid-before proofs are recorded in docs/changelog/2026-09-10-canonical-bubble-source-native.md and docs/audits/2026-09-10-canonical-bubble-batch-native.json. This earlier checkpoint retains its original runtime pins and observed scope.
