# Diamond Phase 6 Settlement Lane Compatibility

Production preflight found a concrete accepted-hand dependency change before any Phase 6 migration was applied. The live twelve-argument `fn_ca_commit_hand_settlement` body changed from MD5 `6685f27ebb50bc05afc04b106353714c` to `7735207b336d55c4953c17fdd3718c97`. Full function-definition comparison showed one behavioral change: its global shared lifecycle advisory lock became `fn_ca_share_settlement_lane_for_table(p_table_id)`.

The pending `20260910030442_diamond_accepted_hands_retain_history_without_chip_obligatio.sql` now preserves that call and validates both the inspected current outer body and the helper body. This prevents Phase 6 from restoring the obsolete lock scheme. No production function was changed by this verification.

The existing production helper has body MD5 `006d78a441e65d000d1d78929649bb44`, owner `postgres`, and execute ACL `{postgres=X/postgres,service_role=X/postgres}`. It acquires the shared `ca:hand-settlement-barrier:v1` barrier, then a tournament-specific shared lane only when the table belongs to a tournament. Its body and ACL are reproduced exactly in the isolated fixture. No helper is added or replaced by the production migration.

The owner-only nine-argument accepted-hand core also has the same one-call production change, body MD5 `1c9a29b3e27345cdaf1704663acd4b25`. The fixture now uses that inspected body, so a stale fixture cannot hide incorrect lifecycle lock ownership. Phase 6 does not replace this production core.

Verification: `python3 tests/sql/run-diamond-accepted-hand.py` passed 50 assertions, the prior 48 plus two focused lane assertions. The new transaction executes the real accepted Diamond hand, observes its shared barrier in `pg_locks`, refuses any obsolete global lifecycle lock, and rolls back. A separate rolled-back fixture transaction verifies the exact helper's tournament lane and private execution ACL. Existing concurrent delivery, response-loss replay, lease refusal, accounting, history, time-bank rollback and projection recovery checks all passed.

Evidence log: `/tmp/diamond-phase6-accepted-lane-regression.log`. Only the dedicated local `poker_diamond_phase6_accepted_test` database was mutated. No production balance, seat, deployment, tournament DDL or engine state was changed. Production migration approval and final publication remain separate release gates.
