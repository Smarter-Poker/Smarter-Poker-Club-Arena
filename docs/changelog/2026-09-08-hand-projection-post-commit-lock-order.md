# Hand projection takes the post-commit lock first

**Date:** 2026-09-08
**Migration:** `20260908155252_hand_projection_takes_post_commit_lock_first.sql`
**Production status:** Applied to `kuklfnapbkmacvwxktbh` on 2026-09-08
(migration ledger version `20260908155252`)

## What was wrong

`fn_project_hand_side_effects(uuid)` claimed its exact
`hand_projection_outbox` row, acquired `hand-projection:<table>`, and updated
`player_stats` before deleting the outbox row. The existing BEFORE DELETE
trigger then called `fn_ca_process_hand_post_commit_obligations(uuid)`, which
tried to acquire `hand-post-commit:<table>`.

The live post-commit path already uses the opposite order. It owns
`hand-post-commit:<table>` before its rake side effects can reach the same
`player_stats` row. Two sessions could therefore form this cycle:

1. projector owns `player_stats`, then waits for `hand-post-commit`;
2. post-commit owns `hand-post-commit`, then waits for `player_stats`.

PostgreSQL correctly killed one request with `40P01`. Retrying that request
would not remove the cycle, so this change does not add a retry.

## Root-cause correction

The migration preserves the exact installed projection implementation under
the owner-only name
`fn_project_hand_side_effects_after_post_commit_20260908(uuid)`. The canonical
service RPC becomes a narrow ordering boundary:

1. read the exact hand and table scope without claiming the outbox;
2. prove that outbox, `hand_history`, and `hand_atomic_commits` identify the
   same immutable hand, table, and hand number;
3. acquire `hand-post-commit:<table>`;
4. process the exact stored post-commit envelope, or fail closed while leaving
   the outbox untouched;
5. acquire `hand-projection:<table>`;
6. call the unchanged projector, which claims the exact outbox row `FOR
UPDATE`, preserves predecessor ordering, applies the existing projections,
   and deletes the row;
7. keep the existing BEFORE DELETE processor call as an idempotent completed
   or legacy-envelope assertion.

The preserved implementation is not executable by `service_role`,
`authenticated`, `anon`, or `PUBLIC`; callers cannot bypass the canonical lock
order. The public RPC and post-commit processor retain their existing service
ACLs. The migration contains catalog assertions for function ownership,
security-definer posture, lock order, predecessor guard, exact outbox claim,
delete trigger, and ACLs.

## Verification

`scripts/dev/probe-hand-projection-lock-order-pg17.sh` creates an isolated
PostgreSQL 17.11 cluster and runs a deterministic two-session schedule against
the real post-commit processor and a minimal projection fixture with the same
lock graph.

- Before the migration, the projector claims the outbox and player-stats row,
  the post-commit session owns its advisory lock, and exactly one `40P01`
  victim is required.
- After the migration, the same schedule blocks the projector on
  `hand-post-commit` before it can claim the outbox. Both requests then finish
  without a deadlock.
- The probe also requires one projection and one rake receipt per hand,
  completed post-commit receipts, an empty outbox, predecessor-order source,
  the idempotent delete trigger, private implementation ACLs, and successful
  reapplication of the forward migration.

Result: original deadlock reproduced; corrected PostgreSQL 17 regression
passed.

Production definition verification confirmed the canonical wrapper takes
`hand-post-commit` before `hand-projection`, the preserved implementation is
owner-only, and only the canonical wrapper remains executable by
`service_role`. The existing event-driven projector is draining the accepted
backlog through that corrected order; no manual replay, retry, cron, or
reconciliation writer was introduced.

## Rollout constraints

This is a database-first change. Apply it only after the preceding
post-commit-obligation migration exists and during an audited quiet cutover
where no pre-change projector call remains in flight. An old in-flight
projector can still hold the historical `player_stats -> hand-post-commit`
order while the new wrapper has already established the new order. The
migration uses a three-second DDL lock timeout and aborts whole on contention or
an unreviewed function definition. There is no retry, cron, data rewrite, or
historical reconciliation in this change.
