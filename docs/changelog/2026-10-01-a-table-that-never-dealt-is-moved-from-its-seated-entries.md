# A Table That Never Dealt Is Moved From Its Seated Entries (2026-10-01)

## What Happened

21ada05e "Early Bird Freeroll (NLH)" dealt nothing after 06:29 UTC. nice_waffle
(835,000) sat alone on b29a51c9. CLTPriya and LuckyRock (2,500 each, late
registrants at 05:08) sat on c0b95966, a table that had never dealt a hand and
was the source of park e1f15079 (park_requested, no manifest). Every resume
logged `f06_movement_admission_unproven [55000]: F06_MOVEMENT_PRIOR_INCOMPLETE`
and `Break e1f15079 not begun: source_engine_absent`.

## Cause

`smarter_private.f06_movement_prior` proves a park from the source table's last
`hand_atomic_commits` row and raised `F06_MOVEMENT_PRIOR_INCOMPLETE` when there
was none. A never-dealt table that was not the event's last table could
therefore never be moved or consolidated. The existing never-dealt path
(`fn_f06_continue_no_start_last_table`) covers only an event's last table.

## Fix

Migration `20261001151056` adds `smarter_private.f06_movement_never_dealt_prior`
and gives `f06_movement_prior` and `f06_assert_movement` one never-dealt branch
each. The proof is admitted only when the table holds no hand row of any kind
and no permit, and every chair holds exactly what its single entry receipt
granted. Every other path is byte-identical (asserted by the migration's
post-image digests). The mixed-custody release pins carry the new
`f06_assert_movement` digest.

Pinned by `tests/a-table-that-never-dealt-is-moved-from-its-seated-entries.law.test.ts`.
