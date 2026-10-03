# A Cash-Table Hand Submission That Can Never Resume Gets a Void Door

Date: 2026-09-26. `supabase/migrations/20260926231546_cash_table_hand_submission_void_door.sql`,
`tests/a-voided-cash-submission-never-moves-a-chip.law.test.ts`. No client change, no workflow change.

## What was wrong

Two live cash tables, `6c9ee4b6` (NLH 1/2 Madness Feeder) and `71d90586`
(NLH 2/5 Classic), have been in a permanent crash-restart loop since
2026-09-22 (~131 `engine_recovery_events` per 15 minutes each, read live
2026-09-26). A third table this incident originally covered, `3c00d4d0`, is
now confirmed recovered (0 crash events in the same 15-minute window) by
PR #5174's unrelated lease-generation-caching fix.

Direct, read-only queries against production (no writes) confirmed the
current `fn_ca_resume_hand_submission` candidate for each table is genuinely
stuck, not a stale/superseded row being mis-selected:

- `6c9ee4b6`: submission `a76d9941-9d25-45de-a7c3-fc2764825057`, hand
  `13637742`, retained 2026-09-22T15:05:32Z. Two seats were taken after the
  hand's own `started_at` and are absent from its `p_stacks` snapshot.
- `71d90586`: submission `3a1bfac4-80cd-4e24-b2ef-574c650247fc`, hand
  `13892489`, retained 2026-09-22T20:12:03Z. One seat's live stack has since
  moved (198.85 -> 450.00, a rebuy taken while the table sat frozen) and no
  longer matches the value the retained request captured.

Both correctly trip `fn_ca_resume_hand_submission`'s
`HAND_SUBMISSION_HANDOFF_STATE_CHANGED` guard - replaying either hand's
math onto a table whose seats have moved on would be wrong. But nothing
existed to say "this specific attempt is abandoned, stop asking" once that
guard fires, so every engine restart re-selects the same submission, the
guard refuses it again, and (per PR #5174's diagnosis of the sibling bug)
that refusal is what feeds the observed `watchdog_kill_rebuild` cycle.

Ruled out: a broader read of every retained submission for both tables
(4299 rows on `71d90586` alone, back to 2026-09-18) confirmed every row
other than the two candidates above already carries its own completed
`hand_atomic_commits` row and is correctly skipped already. The
candidate-selection predicate itself was not defective.

## The fix

`fn_ca_void_unsettled_cash_submission(p_table_id, p_hand_number,
p_receipt_id, p_reason)`: `service_role`-only, cash-table-only (a tournament
hand has its own abort lane, `fn_f06_abort_abandoned_generation` and
siblings), refuses outright if any `hand_atomic_commits` row already exists
for the hand under any submission (the one guarantee that makes this safe -
a hand it can void never had a chip move for it in the first place, so
voiding credits nothing, debits nothing, and touches no wallet), takes the
same `hand:submission:<table>:<hand_number>` advisory lock
`fn_ca_resume_hand_submission` takes before it would ever commit (so the two
can never race), and is receipt-idempotent via
`smarter_private.hand_submission_voids.receipt_id UNIQUE`.

`fn_ca_resume_hand_submission`'s candidate `SELECT` gained one clause -
`AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_voids v WHERE
v.submission_id = j.submission_id)` - byte for byte the rest of the live
`828edb10` body unchanged.

## Hardening

- Regression/law test: `tests/a-voided-cash-submission-never-moves-a-chip.law.test.ts`
  pins the void function's body against every money-write pattern (no
  `chip_ledger`, `chip_transactions`, wallet, or stack write), its
  already-settled refusal, its `service_role`/cash-only/idempotency
  guarantees, and that `fn_ca_resume_hand_submission` actually consults the
  void table.
- Invariant: the void function's only structural path to "success" requires
  the already-settled check to have passed, so a settled hand can never be
  voided by construction.
- Detection: `fn_ca_stuck_cash_hand_submission_check()`, a new read-only
  check (no INSERT/UPDATE/DELETE of its own, pinned by the same law test) on
  its own 10-minute `pg_cron` job (`ca-stuck-cash-hand-submission-10m`),
  independent of the existing hourly `fn_ca_settlement_correctness_check` so
  this migration cannot collide with concurrent edits to that shared
  function. It raises a critical row through the existing
  `fn_ca_raise_drift_incident` path for any cash-table submission retained
  over 10 minutes with no commit and no void - the exact condition that ran
  undetected on these two tables for four days before this fleet caught it
  by its downstream crash-storm symptom instead.
- CI gate: this repository's existing `check-definer-authorization.mjs` and
  `check-new-migration-version-collisions.mjs` both pass against this
  migration (run locally: no anon/authenticated exposure, no version
  collision against `origin/main`).

## What this does NOT do

It does not itself unstick `6c9ee4b6` or `71d90586`. Voiding their two
specific stuck submissions is a live corrective action against production
data (calling the new RPC for those two rows), deliberately left out of this
schema/function migration. Once this is live, the fleet calls
`fn_ca_void_unsettled_cash_submission` for both and verifies both tables
resume dealing.

## Tests

`npx vitest run tests/` (1957 files, 28853 tests, 3 pre-existing unrelated
skips) and `npx tsc --noEmit` both green, unchanged otherwise.
