# A Retention-Pruned Hand Stays Settlement Evidence

Date: 2026-10-14

## What Broke

The original weekly close for union `fade0000` (week 2026-10-05 07:00Z to 2026-10-12 07:00Z) stopped at attempt 70 with `original_restoration_cash_flow_source_refused`. Its finite 245-case original inventory pins 93 settled horse cash hands through two source references each: the hand's `hand_atomic_commits` row (`atomic_economics`) and its signed settlement request (`signed_economics`).

Horse hand history is pruned eight days after settlement (CLAUDE.md 10.5, ruling 1). On 2026-10-14 at 15:33 UTC `sp_prune_hand_history` reached the first 22 of those hands. For each it wrote a `retention_pruned_settled_hand` disposal from the live commit in the same transaction and then deleted the commit. `original_inventory_source_ref_md5` could only read the deleted commit, so 44 certified references (22 atomic, 22 signed) became permanently unverifiable, and every remaining pinned hand would have followed within days.

## Root Fix

The verifier is where the wrong answer was produced, so that is what changed (migration `20261014225815`):

- `atomic_economics`: when no commit row exists, the reference verifies only through exactly one retention disposal for the same submission whose kind, settled and completed flags, submission and pruned hand identity, table and hand number, request hash, finite completion time and eight-day retention boundary all hold, with no history or commit left at that table and hand, and with the retention policy still eight days. The certified digest then stands. Nothing else is accepted.
- `signed_economics`: the existing pruned-request branch keeps every check and reads the commit's settled completion from that disposal when the commit itself was pruned.
- Live hands keep the original digest path unchanged.

The discharge getter pin and the finite-40 source authority pin the verifier's definition, so they move with it in the same transaction, each asserted against its exact preimage and post-image hash, with owner, security, volatility, ACL and configuration unchanged. Because the source authority's definition feeds the inventory generation, the generation advances from `original-inventory-245-v1:417229e7...`; the natural weekly worker re-certifies the original-week caches. No certificate, cache, cutoff, floor, schedule, retention policy or money is written.

## Proof Before Install

Two self-aborting single-transaction trials ran against production on 2026-10-14, building the successor only in `pg_temp`:

- All 1,580 distinct source references of the 245 cases verify under the successor: 44 newly, 0 regressions.
- A forged digest, an unknown hand, an unknown signed submission and a tampered economic stack are refused; a live hand returns its real digest and never the claimed one.
- All three post-image hashes round-trip exactly through `CREATE` and `pg_get_functiondef`.

Pinned by `tests/a-retention-pruned-hand-stays-settlement-evidence.law.test.ts`.
