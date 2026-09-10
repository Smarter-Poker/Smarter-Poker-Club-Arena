# Accounting Phase 3: Exact Hand Generation

Status: database expansion applied and verified; engine publication and overall Phase 3 acceptance remain open.

## Confirmed Regression

The terminal-settlement migration applied at live version 20260909215641 replaced the earlier exact-seat stack and time-bank checks. Migration history still recorded the earlier protection, but the active definitions no longer contained it. Real PostgreSQL reproduced an old hand applying its delta to a replacement occupancy for both cash and tournament players.

## Correction And Live Evidence

Migration file: `20260909234808_restore_exact_hand_generation_after_terminal_writer.sql`.
Applied to the authorized Club Arena project at live version **20260909234808**.
Verified definition MD5s: inner `9be5d1da12d8f674a47a50ffb9a6df81`; 12-argument outer `f93a85ebe5a509ccb7dfedb9be1ed3fa`.
The inner stays owner-only; the outer stays service-only. Anonymous and authenticated roles cannot execute either.
No production transaction probe, balance patch, incident closure, watcher or reconciler was added.

The forward expansion binds stack and time-bank writes to seat row id plus the verbatim join timestamp. It preserves current terminal roster synchronization and zero-stack vacating, and accepts wholly legacy requests during deployment. Exact before/after definition guards permit an identical migration replay but refuse an unknown or partially replaced implementation.

The engine now reads seat id/join timestamp with each authoritative roster, captures immutable generations before constructing the hand, and copies that map into settlement. Stack and time-bank payloads use the dealt map. Time-bank amounts use the already captured snapshot rather than a later engine read. Existing cent precision and occupancy-bound cashout behavior are preserved.

## Verification

- 13 isolated PostgreSQL checks passed with both psql and the CI Node SQL client, including two reproduced original defects.
- The actual migration applied and reapplied successfully in the isolated database.
- Full hand-boundary tests passed in legacy and exact modes, including no-bust and bust outcomes, forced seat/outbox failure rollback, stored history, knockout generation, manager wake, time-bank writes and replay.
- Four additional outer-commit cases reject wrong seat id, wrong join generation, mismatched time-bank generation and a mixed legacy/exact roster without gameplay or accounting side effects.
- Server TypeScript and 35 focused engine/hand-history/time-bank tests passed. Integrated server run: 8462 passed, one law failure, 145 optional PostgreSQL tests skipped. The failure exposed source-replay wrapper ordering; the correction now passes both actual layouts twice and all full-hand probes. Its updated law and final roster identity assertion pass in 30 targeted tests. Required CI remains pending.
- The existing tournament move path already parks the exact source engine and holds its boundary through the atomic RPC. No duplicate move implementation was added.

The full-hand probe reuses the existing source fixture through hand acceptance only. Its separate rebuy section remains independently required; an earlier full combined run on an older clone failed that rebuy assertion and is not called green.

## Rehearsal Provenance And Remaining Gates

Owned rehearsal cluster: `/tmp/ca-phase3-hand-full-4pbwjgge`, socket subdirectory, port 55444, role postgres.
`phase3_current` verified actual migration application/replay; `phase3_stage1` verified the full hand path.
The latter uses a schema-only copy of the known Stage 1 rehearsal with synthetic rows. Its canonical seat-authority wrapper was restored from the pending repository migration; the inspected core was installed under its preserved private name. This models the additive correction surviving the later wrapper installation. No guard was disabled and no other agent's database was changed.
A direct production schema-only dump timed out with zero output; no production data was exported. Earlier incomplete-clone attempts stopped at real prerequisite guards and are not passing evidence.

The pending tournament seat-exit migration is not yet applied in production. It renames the corrected core before wrapping it. The migration source was expanded after the initial live application to also update that preserved core when source replay has already installed the wrapper. Both layouts and repeat applications are verified; production output definitions are unchanged from the initial verified application. Its original applied SQL is retained in Supabase migration history and the local evidence directory. Strict tournament cutover, all twelve CA-03 controls, engine deployment and final acceptance remain open. This checkpoint is not a Phase 3 completion claim.

Read-only admission check: zero active seats have a missing join timestamp. No historical seat was rewritten to satisfy the new engine capture.
