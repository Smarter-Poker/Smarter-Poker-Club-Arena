# Chip audit checkpoint: linked BBJ incident and remaining boundaries

Read-only evidence collected 2026-09-08, approximately 13:25-13:33 UTC.

## Linked incident

Incident ca15a882-0066-425f-94a7-2a6cf636840e remains open. It reports a 0.25 club-chip BBJ discrepancy and points to pool snapshot 249. That snapshot covers 01:38:30.301065 to 02:38:32.391428 UTC: main bank 27,638.21 to 27,902.27 (264.06 increase), journal net 263.81, unexplained 0.25, one recorded write failure.

Ledger-write failure 871 occurred at 02:18:10.791319 UTC, delta 0.25, SQLSTATE 55P03: fn_ca_autoledger bbj_pools.main_balance was cancelled by a lock timeout. This matches the old swallowed-journal-error failure mode reproduced and fixed in migration 20260908024909. The hardened writer rethrows the original SQLSTATE so a failed journal insert aborts the enclosing bank movement.

The failure log does not store a pool/hand identifier. The matching interval, amount and writer strongly support this cause, but do not identify the original transfer's counterparty or operation key. No historical journal entry was invented and this incident was not marked resolved.

## What the incident counter means

The read found 220 unresolved incident rows: 148 with zero discrepancy and 72 with nonzero discrepancy. These are incident rows, not a count of independently proven losses. Examples include 32 settlement-barrier-abandoned notices, 20 rakeback-chain reporting notices, 19 money-function registration notices and 15 guard-definition changes. A zero discrepancy does not make an operational failure harmless; it means that row does not quantify a chip imbalance. Amounts must not be summed across overlapping reports or currencies to infer a loss.

## This phase's releases

- Ticket escrow identity/context: migration 20260908123720 applied; 67 isolated ticket cases; PR #3751 merged.
- Agent send/claim ledger context: migration 20260908125130 applied; 82 isolated cases; PR #3755 merged.
- Rebuy validation on the shared entry receipt path: migration 20260908131745 applied; 46 isolated cases plus 395 preceding cases; PR #3766 open at the last check. Browser receipt validation passed existing client laws, TypeScript, production build and normal related-test push gates.
- Private rebuy registry wiring: migration 20260908133232 applied, exact body hash guarded, owner-only permissions verified; no grants widened.
- Horse funding receipts: migration 20260908121053 applied. PR #3737 still awaiting CI at the last check, after integrating main changes. Engine adoption has not been certified.

## Work that must not be called complete

The complete cash-hand candidate e92b233fa remains unpublished because pending hand writes can still be lost on process death and later settlement continuation is incomplete. Engine hand/action durability, settlement-before-cashout/deal ordering, and post-commit continuation need a complete design and crash tests.

Rebuy purchase keys still live in browser memory. A robust full-lifecycle fix must address purchase identity across reloads/devices and the existing pending-addon delivery path, not merely add a second browser retry queue.

The dedicated rebuy receipt-table candidate 761666754 was superseded by concurrent shared entry receipts. Its hash guard blocked application; it must not be deployed. Current fixes use the shared mechanism instead.

Historical incident correction still needs evidence for each original transfer. The broader MTT/PKO/mystery-bounty, spins/SNG, union-to-club-to-agent/player rake, BBJ, mint and diamond paths are not globally certified by these scoped releases. Other newly introduced private money functions also need their own review and registry entries; they were not mass-approved here.
