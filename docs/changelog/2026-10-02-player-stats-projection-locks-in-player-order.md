# Player Stats Projection Locks In Player Order (2026-10-02)

`DatabaseDeadlocksElevated` (critical) reported 33 deadlocks in 10 minutes on 2026-10-02 13:17-13:27Z. Every cycle in `postgres_logs` was `fn_project_hand_side_effects` against `fn_credit_agent_commissions_batch`, both waiting on `player_stats` row locks.

Projection 2 of `fn_project_hand_side_effects_after_post_commit_20260908` wrote its multi-row `player_stats` upsert in hash-join order, while the cash accounting path locks the same rows `ORDER BY club_id, player_id`. Migration `20261002135232` adds `ORDER BY s.uid::uuid` to Projection 2. The rest of the body is byte-identical to the live definition (md5 of the live `prosrc` `e03e82e32a9ce52d4930ffd7c7703e27`, 12,119 bytes). Row selection and accumulated values are unchanged.

This supersedes the unmerged draft #5542, whose base predates later edits to this function. Its law test is carried over unchanged: `tests/player-stats-projection-locks-in-deterministic-order.law.test.ts`.

Rollback: re-apply the previous definition (the same body without the `ORDER BY s.uid::uuid` line).
